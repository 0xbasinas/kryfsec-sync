/**
 * kryfsec sync server.
 *
 * Stores one encrypted blob per vault. It never sees the sync key, the
 * encryption key or the plain data, and it never logs request bodies.
 *
 *   GET    /health
 *   GET    /v1/vault/:id      -> 200 blob, ETag: "<version>"   (404 if none)
 *   PUT    /v1/vault/:id      -> 200 {version}  needs If-Match: "<version>" or If-None-Match: *
 *                                409 {version} when the version does not match
 *   DELETE /v1/vault/:id      -> 204
 *
 * Every vault request needs "Authorization: Bearer <token>". The first PUT
 * saves a SHA-256 hash of the token; later requests must send the same token.
 */
import { DurableObject } from 'cloudflare:workers'

export interface Env {
  VAULTS: DurableObjectNamespace<Vault>
}

/** Biggest blob we keep (after encryption). */
const MAX_BYTES = 4 * 1024 * 1024
/** Stored in pieces because one SQLite value can hold at most 2 MB. */
const CHUNK = 1024 * 1024
/** Requests per minute for one vault, and for one IP (per Worker instance). */
const VAULT_PER_MIN = 60
const IP_PER_MIN = 120
/** A vault nobody used for this long is removed. */
const IDLE_TTL_MS = 400 * 24 * 60 * 60 * 1000

const VAULT_PATH = /^\/v1\/vault\/([0-9a-f]{32})$/
const TOKEN = /^Bearer ([A-Za-z0-9_-]{32,128})$/

const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, PUT, DELETE, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, if-match, if-none-match',
  'access-control-expose-headers': 'etag, x-vault-version',
  'access-control-max-age': '86400'
}

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS, ...extra }
  })
}

const versionHeaders = (v: number): Record<string, string> => ({ etag: `"${v}"`, 'x-vault-version': String(v) })

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** Sliding one-minute window. Best effort: kept in memory. */
class Limiter {
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

const ipLimiter = new Limiter(IP_PER_MIN)

type Ifs = { ifMatch: number | null; ifNoneMatch: boolean }

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

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
    if (url.pathname === '/health' && req.method === 'GET') return json(200, { ok: true, service: 'kryfsec-sync', version: 1 })
    if (url.pathname === '/' && req.method === 'GET') {
      return json(200, { service: 'kryfsec-sync', docs: 'https://github.com/0xbasinas/kryfsec-sync' })
    }

    const m = VAULT_PATH.exec(url.pathname)
    if (!m) return json(404, { error: 'not found' })
    if (!['GET', 'PUT', 'DELETE'].includes(req.method)) return json(405, { error: 'method not allowed' })

    const ip = req.headers.get('cf-connecting-ip') ?? 'unknown'
    if (!ipLimiter.allow(ip)) return json(429, { error: 'too many requests' }, { 'retry-after': '60' })

    const t = TOKEN.exec(req.headers.get('authorization') ?? '')
    if (!t) return json(401, { error: 'missing or bad token' })
    const tokenHash = await sha256Hex(t[1])

    let body: ArrayBuffer | undefined
    let ifs: Ifs | null = null
    if (req.method === 'PUT') {
      ifs = parseIfs(req)
      if (!ifs) return json(428, { error: 'send If-Match: "<version>" or If-None-Match: *' })
      const len = Number(req.headers.get('content-length') ?? '0')
      if (len > MAX_BYTES) return json(413, { error: `too large (max ${MAX_BYTES} bytes)` })
      body = await req.arrayBuffer()
      if (body.byteLength > MAX_BYTES) return json(413, { error: `too large (max ${MAX_BYTES} bytes)` })
      if (body.byteLength === 0) return json(400, { error: 'empty body' })
    }

    const stub = env.VAULTS.get(env.VAULTS.idFromName(m[1]))
    const r = (await stub.handle(req.method as 'GET' | 'PUT' | 'DELETE', tokenHash, ifs, body)) as unknown as HandleResult
    if (r.kind === 'blob') {
      return new Response(r.body, {
        status: 200,
        headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', ...CORS, ...versionHeaders(r.version) }
      })
    }
    if (r.kind === 'deleted') return new Response(null, { status: 204, headers: CORS })
    const extra = r.version !== undefined && r.version !== null ? versionHeaders(r.version) : {}
    return json(r.status, r.body, extra)
  }
} satisfies ExportedHandler<Env>

type HandleResult =
  | { kind: 'blob'; body: ArrayBuffer; version: number }
  | { kind: 'deleted' }
  | { kind: 'json'; status: number; body: unknown; version?: number | null }

/** One Durable Object per vault, so writes to a vault happen one at a time. */
export class Vault extends DurableObject<Env> {
  private sql: SqlStorage
  private limiter = new Limiter(VAULT_PER_MIN)

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
  }

  /** deleteAll() also drops the tables, so make sure they exist each time. */
  private tables(): void {
    this.sql.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)')
    this.sql.exec('CREATE TABLE IF NOT EXISTS chunks (i INTEGER PRIMARY KEY, data BLOB NOT NULL)')
  }

  private meta(k: string): string | null {
    const rows = this.sql.exec<{ v: string }>('SELECT v FROM meta WHERE k = ?', k).toArray()
    return rows[0]?.v ?? null
  }

  private setMeta(k: string, v: string): void {
    this.sql.exec('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, v)
  }

  async handle(method: 'GET' | 'PUT' | 'DELETE', tokenHash: string, ifs: Ifs | null, body?: ArrayBuffer): Promise<HandleResult> {
    if (!this.limiter.allow('v')) return { kind: 'json', status: 429, body: { error: 'too many requests' } }
    this.tables()
    const auth = this.meta('auth')
    const versionRaw = this.meta('version')
    const version = versionRaw === null ? null : Number(versionRaw)

    if (auth !== null && !sameString(auth, tokenHash)) return { kind: 'json', status: 401, body: { error: 'wrong token' } }

    if (method === 'GET') {
      if (auth === null || version === null) return { kind: 'json', status: 404, body: { error: 'no vault' } }
      const parts = this.sql.exec<{ data: ArrayBuffer }>('SELECT data FROM chunks ORDER BY i').toArray()
      const total = parts.reduce((n, p) => n + p.data.byteLength, 0)
      const out = new Uint8Array(total)
      let o = 0
      for (const p of parts) {
        out.set(new Uint8Array(p.data), o)
        o += p.data.byteLength
      }
      return { kind: 'blob', body: out.buffer, version }
    }

    if (method === 'DELETE') {
      if (auth === null) return { kind: 'json', status: 404, body: { error: 'no vault' } }
      await this.ctx.storage.deleteAlarm()
      await this.ctx.storage.deleteAll()
      return { kind: 'deleted' }
    }

    // PUT
    if (!ifs || !body) return { kind: 'json', status: 400, body: { error: 'bad request' } }
    if (version === null) {
      if (!ifs.ifNoneMatch) return { kind: 'json', status: 409, body: { error: 'vault does not exist yet', version: null } }
    } else if (ifs.ifNoneMatch || ifs.ifMatch !== version) {
      return { kind: 'json', status: 409, body: { error: 'version changed, pull and merge first', version }, version }
    }
    const next = (version ?? 0) + 1
    const bytes = new Uint8Array(body)
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM chunks')
      for (let i = 0, n = 0; i < bytes.length; i += CHUNK, n++) this.sql.exec('INSERT INTO chunks (i, data) VALUES (?, ?)', n, bytes.slice(i, i + CHUNK))
      if (auth === null) this.setMeta('auth', tokenHash)
      this.setMeta('version', String(next))
      this.setMeta('updated', String(Date.now()))
    })
    await this.ctx.storage.setAlarm(Date.now() + IDLE_TTL_MS)
    return { kind: 'json', status: version === null ? 201 : 200, body: { version: next }, version: next }
  }

  /** Nobody used this vault for a long time: remove it. */
  async alarm(): Promise<void> {
    this.tables()
    const updated = Number(this.meta('updated') ?? '0')
    if (Date.now() - updated >= IDLE_TTL_MS - 60_000) await this.ctx.storage.deleteAll()
    else await this.ctx.storage.setAlarm(updated + IDLE_TTL_MS)
  }
}
