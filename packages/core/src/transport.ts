import type { VaultKeys } from './crypto'

/** Smallest HTTP call the sync code needs. Apps pass fetch, or their own (e.g. over IPC). */
export interface HttpRequest {
  method: 'GET' | 'PUT' | 'POST' | 'DELETE'
  url: string
  headers: Record<string, string>
  body?: Uint8Array
}
export interface HttpResponse {
  status: number
  headers: Record<string, string>
  body: Uint8Array
}
export type HttpFn = (req: HttpRequest) => Promise<HttpResponse>

export type PutResult = { ok: true; version: number } | { ok: false; version: number | null; missing?: string[] }

/** What GET returns: format 1 = one encrypted doc (old), format 2 = encrypted manifest. */
export interface Remote {
  version: number
  format: 1 | 2
  body: Uint8Array
}

export interface Transport {
  /** null when the vault does not exist yet. */
  get(): Promise<Remote | null>
  /** Fetch pieces by name. Names the server does not have are left out. */
  readChunks(names: string[]): Promise<Map<string, Uint8Array>>
  /** Upload pieces (not visible until a manifest that uses them is committed). */
  writeChunks(chunks: { name: string; data: Uint8Array }[]): Promise<void>
  /** Save a new manifest. ifMatch null = create the vault. ok:false on a version clash. */
  commit(manifest: Uint8Array, refs: string[], ifMatch: number | null): Promise<PutResult>
  remove(): Promise<void>
}

export class SyncHttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

/** The server could not be reached (offline, DNS, timeout). */
export class SyncNetworkError extends Error {
  constructor(message = 'Could not reach the sync server') {
    super(message)
    this.name = 'SyncNetworkError'
  }
}

export const DEFAULT_SYNC_URL = 'https://sync.kryfsec.com'
/** Most bytes sent or asked for in one request. The server allows a bit more. */
export const BATCH_BYTES = 4 * 1024 * 1024
/** Most stored bytes per vault (all pieces in the current manifest). */
export const MAX_VAULT_BYTES = 64 * 1024 * 1024
/** Most names in one read request. */
export const BATCH_NAMES = 512

/** Use the platform fetch as an HttpFn. */
export function fetchHttp(f: typeof fetch = fetch): HttpFn {
  return async (req) => {
    let res: Response
    try {
      res = await f(req.url, { method: req.method, headers: req.headers, body: req.body as BodyInit | undefined })
    } catch (err) {
      throw new SyncNetworkError(err instanceof Error ? err.message : String(err))
    }
    const headers: Record<string, string> = {}
    res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v))
    return { status: res.status, headers, body: new Uint8Array(await res.arrayBuffer()) }
  }
}

const versionOf = (h: Record<string, string>): number | null => {
  const raw = h['etag'] ?? h['x-vault-version']
  if (!raw) return null
  const n = parseInt(raw.replace(/^W\//, '').replace(/"/g, ''), 10)
  return Number.isFinite(n) ? n : null
}

function errorBody(body: Uint8Array): { error?: string; missing?: string[] } {
  try {
    return JSON.parse(new TextDecoder().decode(body)) as { error?: string; missing?: string[] }
  } catch {
    return {}
  }
}

const hexToBytes = (h: string): Uint8Array => {
  const out = new Uint8Array(h.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
  return out
}
const bytesToHex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')

/**
 * Many pieces in one body: for each, [16-byte name][4-byte big-endian length][data].
 * Used both ways (upload and download).
 */
export function packChunks(chunks: { name: string; data: Uint8Array }[]): Uint8Array {
  const total = chunks.reduce((s, c) => s + 20 + c.data.length, 0)
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  let o = 0
  for (const c of chunks) {
    out.set(hexToBytes(c.name), o)
    view.setUint32(o + 16, c.data.length)
    out.set(c.data, o + 20)
    o += 20 + c.data.length
  }
  return out
}

export function unpackChunks(body: Uint8Array): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>()
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength)
  let o = 0
  while (o + 20 <= body.length) {
    const name = bytesToHex(body.subarray(o, o + 16))
    const len = view.getUint32(o + 16)
    if (o + 20 + len > body.length) throw new Error('Sync server sent a broken chunk list')
    out.set(name, body.slice(o + 20, o + 20 + len))
    o += 20 + len
  }
  return out
}

const json = (x: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(x))

function toBase64(b: Uint8Array): string {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let out = ''
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0)
    out += A[(n >> 18) & 63] + A[(n >> 12) & 63] + (i + 1 < b.length ? A[(n >> 6) & 63] : '=') + (i + 2 < b.length ? A[n & 63] : '=')
  }
  return out
}

/** Talks to the server's v2 API. */
export function httpTransport(opts: { baseUrl?: string; keys: VaultKeys; http: HttpFn }): Transport {
  const url = `${(opts.baseUrl ?? DEFAULT_SYNC_URL).replace(/\/$/, '')}/v2/vault/${opts.keys.vaultId}`
  const auth = { authorization: `Bearer ${opts.keys.authToken}` }
  const fail = (r: HttpResponse): never => {
    const msg = errorBody(r.body).error
    throw new SyncHttpError(r.status, `Sync server said ${r.status}${msg ? `: ${msg}` : ''}`)
  }
  return {
    async get() {
      const r = await opts.http({ method: 'GET', url, headers: { ...auth } })
      if (r.status === 404) return null
      if (r.status !== 200) fail(r)
      const version = versionOf(r.headers)
      if (version === null) throw new SyncHttpError(r.status, 'Sync server sent no version')
      const format = r.headers['x-vault-format'] === '1' ? 1 : 2
      return { version, format, body: r.body }
    },
    async readChunks(names) {
      const out = new Map<string, Uint8Array>()
      let left = [...new Set(names)]
      while (left.length) {
        const batch = left.slice(0, BATCH_NAMES)
        const r = await opts.http({
          method: 'POST',
          url: `${url}/chunks/read`,
          headers: { ...auth, 'content-type': 'application/json' },
          body: json({ names: batch })
        })
        if (r.status !== 200) fail(r)
        const got = unpackChunks(r.body)
        for (const [k, v] of got) out.set(k, v)
        // The server sends as many as fit in one reply; ask again for the rest.
        // A name it does not have is skipped (and reported by the caller).
        const missing = new Set(r.headers['x-missing'] ? r.headers['x-missing'].split(',') : [])
        left = left.filter((n) => !out.has(n) && !missing.has(n))
        if (got.size === 0) break
      }
      return out
    },
    async writeChunks(chunks) {
      let batch: { name: string; data: Uint8Array }[] = []
      let size = 0
      const send = async (): Promise<void> => {
        if (!batch.length) return
        const r = await opts.http({
          method: 'POST',
          url: `${url}/chunks`,
          headers: { ...auth, 'content-type': 'application/octet-stream' },
          body: packChunks(batch)
        })
        if (r.status !== 200) fail(r)
        batch = []
        size = 0
      }
      for (const c of chunks) {
        if (size + c.data.length + 20 > BATCH_BYTES) await send()
        batch.push(c)
        size += c.data.length + 20
      }
      await send()
    },
    async commit(manifest, refs, ifMatch) {
      const cond: Record<string, string> = ifMatch === null ? { 'if-none-match': '*' } : { 'if-match': `"${ifMatch}"` }
      const r = await opts.http({
        method: 'PUT',
        url,
        headers: { ...auth, ...cond, 'content-type': 'application/json' },
        body: json({ manifest: toBase64(manifest), refs })
      })
      if (r.status === 409 || r.status === 412) return { ok: false, version: versionOf(r.headers), missing: errorBody(r.body).missing }
      if (r.status !== 200 && r.status !== 201) fail(r)
      const version = versionOf(r.headers)
      if (version === null) throw new SyncHttpError(r.status, 'Sync server sent no version')
      return { ok: true, version }
    },
    async remove() {
      const r = await opts.http({ method: 'DELETE', url, headers: { ...auth } })
      if (r.status !== 204 && r.status !== 404) fail(r)
    }
  }
}
