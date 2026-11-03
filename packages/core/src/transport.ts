import type { VaultKeys } from './crypto'

/** Smallest HTTP call the sync code needs. Apps pass fetch, or their own (e.g. over IPC). */
export interface HttpRequest {
  method: 'GET' | 'PUT' | 'DELETE'
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

export type PutResult = { ok: true; version: number } | { ok: false; version: number | null }

export interface Transport {
  /** null when the vault does not exist yet. */
  get(): Promise<{ version: number; body: Uint8Array } | null>
  /** ifMatch null = create the vault. Returns ok:false on a version clash (409/412). */
  put(body: Uint8Array, ifMatch: number | null): Promise<PutResult>
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

export const DEFAULT_SYNC_URL = 'https://sync.kryfsec.com'

/** Use the platform fetch as an HttpFn. */
export function fetchHttp(f: typeof fetch = fetch): HttpFn {
  return async (req) => {
    const res = await f(req.url, { method: req.method, headers: req.headers, body: req.body as BodyInit | undefined })
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

function errorText(body: Uint8Array): string {
  try {
    const j = JSON.parse(new TextDecoder().decode(body)) as { error?: string }
    return j.error ?? ''
  } catch {
    return ''
  }
}

export function httpTransport(opts: { baseUrl?: string; keys: VaultKeys; http: HttpFn }): Transport {
  const url = `${(opts.baseUrl ?? DEFAULT_SYNC_URL).replace(/\/$/, '')}/v1/vault/${opts.keys.vaultId}`
  const auth = { authorization: `Bearer ${opts.keys.authToken}` }
  const fail = (r: HttpResponse): never => {
    const msg = errorText(r.body)
    throw new SyncHttpError(r.status, `Sync server said ${r.status}${msg ? `: ${msg}` : ''}`)
  }
  return {
    async get() {
      const r = await opts.http({ method: 'GET', url, headers: { ...auth } })
      if (r.status === 404) return null
      if (r.status !== 200) fail(r)
      const version = versionOf(r.headers)
      if (version === null) throw new SyncHttpError(r.status, 'Sync server sent no version')
      return { version, body: r.body }
    },
    async put(body, ifMatch) {
      const cond: Record<string, string> = ifMatch === null ? { 'if-none-match': '*' } : { 'if-match': `"${ifMatch}"` }
      const r = await opts.http({
        method: 'PUT',
        url,
        headers: { ...auth, ...cond, 'content-type': 'application/octet-stream' },
        body
      })
      if (r.status === 409 || r.status === 412) return { ok: false, version: versionOf(r.headers) }
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
