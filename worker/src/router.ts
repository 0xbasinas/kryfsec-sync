/**
 * HTTP side of the sync server: checks paths, sizes, tokens and rate limits,
 * then hands the request to the vault's Durable Object.
 */
import { MAX_READ_NAMES, MAX_REQUEST_BYTES, MAX_V1_BYTES, NAME, type Ifs, type Op, type Result } from './store'

export interface VaultHandle {
  handle(tokenHash: string, op: Op): Promise<Result>
}

/** Requests per minute for one vault, and for one IP (per Worker instance). */
export const VAULT_PER_MIN = 120
export const IP_PER_MIN = 240

const V1_PATH = /^\/v1\/vault\/([0-9a-f]{32})$/
const V2_PATH = /^\/v2\/vault\/([0-9a-f]{32})(\/chunks|\/chunks\/read)?$/
const TOKEN = /^Bearer ([A-Za-z0-9_-]{32,128})$/

export const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, PUT, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, if-match, if-none-match',
  'access-control-expose-headers': 'etag, x-vault-version, x-vault-format, x-missing',
  'access-control-max-age': '86400'
}

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS, ...extra }
  })
}

const versionHeaders = (v: number | null | undefined): Record<string, string> =>
  v === null || v === undefined ? {} : { etag: `"${v}"`, 'x-vault-version': String(v) }

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Sliding one-minute window. Best effort: kept in memory. */
export class Limiter {
  private hits = new Map<string, number[]>()
  constructor(private max: number) {}
  allow(key: string, now = Date.now()): boolean {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < 60_000)
    if (list.length >= this.max) {
      this.hits.set(key, list)
      return false
    }
    list.push(now)
    this.hits.set(key, list)
    if (this.hits.size > 10_000) this.hits.clear()
    return true
  }
}

function parseIfs(req: Request): Ifs | null {
  const im = req.headers.get('if-match')
  const inm = req.headers.get('if-none-match')
  if (inm && inm.trim() === '*') return { ifMatch: null, ifNoneMatch: true }
  if (im) {
    const n = parseInt(im.replace(/^W\//, '').replace(/"/g, '').trim(), 10)
    if (Number.isFinite(n) && n >= 0) return { ifMatch: n, ifNoneMatch: false }
  }
  return null
}

async function readBody(req: Request, max: number): Promise<ArrayBuffer | Response> {
  const len = Number(req.headers.get('content-length') ?? '0')
  if (len > max) return json(413, { error: `too large (max ${max} bytes)` })
  const body = await req.arrayBuffer()
  if (body.byteLength > max) return json(413, { error: `too large (max ${max} bytes)` })
  if (body.byteLength === 0) return json(400, { error: 'empty body' })
  return body
}

function fromBase64(s: string): Uint8Array | null {
  try {
    const bin = atob(s)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

function toResponse(r: Result): Response {
  const headers = { ...CORS, 'cache-control': 'no-store', ...versionHeaders(r.version), ...(r.headers ?? {}) }
  if (r.status === 204) return new Response(null, { status: 204, headers: CORS })
  if (r.bytes) return new Response(r.bytes, { status: r.status, headers: { 'content-type': 'application/octet-stream', ...headers } })
  return new Response(JSON.stringify(r.json ?? {}), { status: r.status, headers: { 'content-type': 'application/json', ...headers } })
}

const ipLimiter = new Limiter(IP_PER_MIN)

export async function route(req: Request, vault: (id: string) => VaultHandle, ips: Limiter = ipLimiter): Promise<Response> {
  const url = new URL(req.url)
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
  if (url.pathname === '/health' && req.method === 'GET') return json(200, { ok: true, service: 'kryfsec-sync', version: 2, formats: [1, 2] })
  if (url.pathname === '/' && req.method === 'GET') return json(200, { service: 'kryfsec-sync', docs: 'https://github.com/0xbasinas/kryfsec-sync' })

  const m1 = V1_PATH.exec(url.pathname)
  const m2 = m1 ? null : V2_PATH.exec(url.pathname)
  if (!m1 && !m2) return json(404, { error: 'not found' })
  const id = (m1 ?? m2)![1]
  const sub = m2?.[2] ?? ''

  const allowed = sub ? ['POST'] : ['GET', 'PUT', 'DELETE']
  if (!allowed.includes(req.method)) return json(405, { error: 'method not allowed' })

  const ip = req.headers.get('cf-connecting-ip') ?? 'unknown'
  if (!ips.allow(ip)) return json(429, { error: 'too many requests' }, { 'retry-after': '60' })

  const t = TOKEN.exec(req.headers.get('authorization') ?? '')
  if (!t) return json(401, { error: 'missing or bad token' })
  const tokenHash = await sha256Hex(t[1])

  let op: Op
  if (req.method === 'GET') op = { op: 'get', api: m1 ? 1 : 2 }
  else if (req.method === 'DELETE') op = { op: 'delete' }
  else if (m1) {
    const ifs = parseIfs(req)
    if (!ifs) return json(428, { error: 'send If-Match: "<version>" or If-None-Match: *' })
    const body = await readBody(req, MAX_V1_BYTES)
    if (body instanceof Response) return body
    op = { op: 'put1', ifs, body }
  } else if (sub === '/chunks') {
    const body = await readBody(req, MAX_REQUEST_BYTES)
    if (body instanceof Response) return body
    op = { op: 'write', body }
  } else if (sub === '/chunks/read') {
    const body = await readBody(req, 64 * 1024)
    if (body instanceof Response) return body
    let names: unknown
    try {
      names = (JSON.parse(new TextDecoder().decode(body)) as { names?: unknown }).names
    } catch {
      return json(400, { error: 'send JSON {"names": [...]}' })
    }
    if (!Array.isArray(names) || names.length === 0 || names.length > MAX_READ_NAMES || !names.every((n) => typeof n === 'string' && NAME.test(n))) {
      return json(400, { error: `send 1 to ${MAX_READ_NAMES} chunk names` })
    }
    op = { op: 'read', names: names as string[] }
  } else {
    const ifs = parseIfs(req)
    if (!ifs) return json(428, { error: 'send If-Match: "<version>" or If-None-Match: *' })
    const body = await readBody(req, 2 * 1024 * 1024)
    if (body instanceof Response) return body
    let parsed: { manifest?: unknown; refs?: unknown }
    try {
      parsed = JSON.parse(new TextDecoder().decode(body)) as typeof parsed
    } catch {
      return json(400, { error: 'send JSON {"manifest": "<base64>", "refs": [...]}' })
    }
    const manifest = typeof parsed.manifest === 'string' ? fromBase64(parsed.manifest) : null
    const refs = parsed.refs
    if (!manifest || !Array.isArray(refs) || !refs.every((n) => typeof n === 'string' && NAME.test(n))) {
      return json(400, { error: 'send JSON {"manifest": "<base64>", "refs": [...]}' })
    }
    op = { op: 'commit', ifs, manifest: manifest.slice().buffer, refs: refs as string[] }
  }

  return toResponse(await vault(id).handle(tokenHash, op))
}
