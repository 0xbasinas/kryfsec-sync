/**
 * The storage logic of one vault, kept apart from Cloudflare APIs so tests
 * can run it on Node's SQLite.
 *
 * Format 1 (old apps): one encrypted blob, saved in 1 MB rows.
 * Format 2: content-named encrypted pieces ("blobs") plus one encrypted
 * manifest that lists them. A commit replaces the manifest and the list of
 * referenced pieces in one transaction, then drops pieces nobody uses.
 */

export interface SqlLike {
  exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): { toArray(): T[] }
}

export interface StoreHost {
  sql: SqlLike
  transaction(fn: () => void): void
  deleteAll(): Promise<void>
  setAlarm(at: number): Promise<void>
  getAlarm(): Promise<number | null>
  deleteAlarm(): Promise<void>
  now(): number
}

/** Format 1: biggest blob (after encryption). */
export const MAX_V1_BYTES = 4 * 1024 * 1024
/** Format 1 rows. One SQLite value can hold at most 2 MB. */
const V1_ROW = 1024 * 1024
/** Biggest single piece. */
export const MAX_CHUNK_BYTES = 1024 * 1024
/** Biggest upload body, and biggest download reply. */
export const MAX_REQUEST_BYTES = 8 * 1024 * 1024
/** Most names in one read request. */
export const MAX_READ_NAMES = 512
/** Biggest manifest. */
export const MAX_MANIFEST_BYTES = 1024 * 1024
/** Most pieces one manifest can use. */
export const MAX_REFS = 20_000
/** All pieces the current manifest uses, plus the manifest. */
export const MAX_COMMITTED_BYTES = 64 * 1024 * 1024
/** Everything stored, including uploads not committed yet. */
export const MAX_STORED_BYTES = 128 * 1024 * 1024
/** Pieces not used by any manifest are dropped after this long. */
export const ORPHAN_TTL_MS = 24 * 60 * 60 * 1000
/** A vault nobody used for this long is removed. */
export const IDLE_TTL_MS = 400 * 24 * 60 * 60 * 1000
/** A vault that got uploads but never a commit is removed after this long. */
export const PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000

export type Ifs = { ifMatch: number | null; ifNoneMatch: boolean }

export type Op =
  | { op: 'get'; api: 1 | 2 }
  | { op: 'put1'; ifs: Ifs; body: ArrayBuffer }
  | { op: 'write'; body: ArrayBuffer }
  | { op: 'read'; names: string[] }
  | { op: 'commit'; ifs: Ifs; manifest: ArrayBuffer; refs: string[] }
  | { op: 'delete' }

export interface Result {
  status: number
  /** JSON body (or bytes). */
  json?: unknown
  bytes?: ArrayBuffer
  version?: number | null
  headers?: Record<string, string>
}

export const NAME = /^[0-9a-f]{32}$/

const toBytes = (x: unknown): Uint8Array => (x instanceof Uint8Array ? x : new Uint8Array(x as ArrayBuffer))
const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')

export function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** [16-byte name][u32 big-endian length][data], repeated. */
export function parsePack(buf: ArrayBuffer): { name: string; data: Uint8Array }[] | string {
  const b = new Uint8Array(buf)
  const view = new DataView(buf)
  const out: { name: string; data: Uint8Array }[] = []
  let o = 0
  while (o < b.length) {
    if (o + 20 > b.length) return 'broken chunk list'
    const name = hex(b.subarray(o, o + 16))
    const len = view.getUint32(o + 16)
    if (len === 0 || len > MAX_CHUNK_BYTES) return `each chunk must be 1 to ${MAX_CHUNK_BYTES} bytes`
    if (o + 20 + len > b.length) return 'broken chunk list'
    out.push({ name, data: b.slice(o + 20, o + 20 + len) })
    o += 20 + len
  }
  return out
}

function pack(items: { name: string; data: Uint8Array }[]): ArrayBuffer {
  const total = items.reduce((s, x) => s + 20 + x.data.length, 0)
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  let o = 0
  for (const x of items) {
    for (let i = 0; i < 16; i++) out[o + i] = parseInt(x.name.slice(i * 2, i * 2 + 2), 16)
    view.setUint32(o + 16, x.data.length)
    out.set(x.data, o + 20)
    o += 20 + x.data.length
  }
  return out.buffer
}

const err = (status: number, error: string, extra: Partial<Result> = {}): Result => ({ status, json: { error }, ...extra })
const UPGRADED = 'This vault was upgraded by a newer kryfsec. Please update this app.'

export class VaultStore {
  constructor(private h: StoreHost) {}

  private get sql(): SqlLike {
    return this.h.sql
  }

  /** deleteAll() also drops the tables, so make sure they exist each time. */
  private tables(): void {
    const s = this.sql
    s.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)')
    s.exec('CREATE TABLE IF NOT EXISTS chunks (i INTEGER PRIMARY KEY, data BLOB NOT NULL)')
    s.exec('CREATE TABLE IF NOT EXISTS blobs (name TEXT PRIMARY KEY, data BLOB NOT NULL, size INTEGER NOT NULL, created INTEGER NOT NULL)')
    s.exec('CREATE TABLE IF NOT EXISTS refs (name TEXT PRIMARY KEY, gen INTEGER NOT NULL)')
    s.exec('CREATE TABLE IF NOT EXISTS manifest (i INTEGER PRIMARY KEY, data BLOB NOT NULL)')
  }

  private meta(k: string): string | null {
    return this.sql.exec<{ v: string }>('SELECT v FROM meta WHERE k = ?', k).toArray()[0]?.v ?? null
  }

  private setMeta(k: string, v: string): void {
    this.sql.exec('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, v)
  }

  private storedBytes(): number {
    const a = this.sql.exec<{ n: number | null }>('SELECT SUM(size) AS n FROM blobs').toArray()[0]?.n ?? 0
    const b = this.sql.exec<{ n: number | null }>('SELECT SUM(LENGTH(data)) AS n FROM chunks').toArray()[0]?.n ?? 0
    return Number(a) + Number(b)
  }

  /** False for a vault that was never written (or was deleted). */
  private exists(): boolean {
    return this.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'").toArray().length > 0
  }

  async handle(tokenHash: string, op: Op): Promise<Result> {
    // Reads of a vault that does not exist must not create tables: that would
    // leave an empty object behind for every wrong or old vault id.
    if ((op.op === 'get' || op.op === 'read' || op.op === 'delete') && !this.exists()) return err(404, 'no vault')
    this.tables()
    const auth = this.meta('auth')
    const vRaw = this.meta('version')
    const version = vRaw === null ? null : Number(vRaw)
    const format = this.meta('format') === '2' ? 2 : 1
    if (auth !== null && !sameString(auth, tokenHash)) return err(401, 'wrong token')
    const now = this.h.now()

    switch (op.op) {
      case 'get': {
        if (auth === null || version === null) return err(404, 'no vault')
        if (format === 2) {
          if (op.api === 1) return err(410, UPGRADED, { version })
          const rows = this.sql.exec<{ data: unknown }>('SELECT data FROM manifest ORDER BY i').toArray()
          return { status: 200, bytes: toBytes(rows[0]?.data ?? new Uint8Array()).slice().buffer, version, headers: { 'x-vault-format': '2' } }
        }
        const parts = this.sql.exec<{ data: unknown }>('SELECT data FROM chunks ORDER BY i').toArray().map((p) => toBytes(p.data))
        const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
        let o = 0
        for (const p of parts) {
          out.set(p, o)
          o += p.length
        }
        return { status: 200, bytes: out.buffer, version, headers: { 'x-vault-format': '1' } }
      }

      case 'delete': {
        if (auth === null) return err(404, 'no vault')
        await this.h.deleteAlarm()
        await this.h.deleteAll()
        return { status: 204 }
      }

      case 'put1': {
        if (format === 2 && version !== null) return err(410, UPGRADED, { version })
        const clash = this.clash(op.ifs, version)
        if (clash) return clash
        const next = (version ?? 0) + 1
        const bytes = new Uint8Array(op.body)
        this.h.transaction(() => {
          this.sql.exec('DELETE FROM chunks')
          for (let i = 0, n = 0; i < bytes.length; i += V1_ROW, n++) this.sql.exec('INSERT INTO chunks (i, data) VALUES (?, ?)', n, bytes.slice(i, i + V1_ROW))
          if (auth === null) this.setMeta('auth', tokenHash)
          this.setMeta('version', String(next))
          this.setMeta('format', '1')
          this.setMeta('updated', String(now))
        })
        await this.h.setAlarm(now + IDLE_TTL_MS)
        return { status: version === null ? 201 : 200, json: { version: next }, version: next }
      }

      case 'write': {
        const items = parsePack(op.body)
        if (typeof items === 'string') return err(400, items)
        for (const x of items) if (!NAME.test(x.name)) return err(400, 'bad chunk name')
        const have = new Set<string>()
        let adding = 0
        for (const x of items) {
          const row = this.sql.exec<{ size: number }>('SELECT size FROM blobs WHERE name = ?', x.name).toArray()[0]
          if (row) have.add(x.name)
          else adding += x.data.length
        }
        if (this.storedBytes() + adding > MAX_STORED_BYTES) {
          this.dropOrphans(now)
          if (this.storedBytes() + adding > MAX_STORED_BYTES) return err(413, `vault storage is full (max ${MAX_STORED_BYTES} bytes)`)
        }
        this.h.transaction(() => {
          for (const x of items) {
            if (have.has(x.name)) continue
            this.sql.exec('INSERT OR IGNORE INTO blobs (name, data, size, created) VALUES (?, ?, ?, ?)', x.name, x.data, x.data.length, now)
          }
          if (auth === null) this.setMeta('auth', tokenHash)
          this.setMeta('updated', String(now))
        })
        if (version === null && (await this.h.getAlarm()) === null) await this.h.setAlarm(now + PENDING_TTL_MS)
        return { status: 200, json: { stored: items.length - have.size, had: have.size } }
      }

      case 'read': {
        if (auth === null) return err(404, 'no vault')
        const out: { name: string; data: Uint8Array }[] = []
        const missing: string[] = []
        let size = 0
        for (const name of op.names) {
          const row = this.sql.exec<{ data: unknown; size: number }>('SELECT data, size FROM blobs WHERE name = ?', name).toArray()[0]
          if (!row) {
            missing.push(name)
            continue
          }
          // Always send at least one, then stop before the reply gets too big.
          if (out.length && size + 20 + row.size > MAX_REQUEST_BYTES) break
          out.push({ name, data: toBytes(row.data) })
          size += 20 + row.size
        }
        return { status: 200, bytes: pack(out), headers: missing.length ? { 'x-missing': missing.join(',') } : {} }
      }

      case 'commit': {
        const clash = this.clash(op.ifs, version)
        if (clash) return clash
        const manifest = new Uint8Array(op.manifest)
        if (manifest.length === 0 || manifest.length > MAX_MANIFEST_BYTES) return err(400, `manifest must be 1 to ${MAX_MANIFEST_BYTES} bytes`)
        const refs = [...new Set(op.refs)]
        if (refs.length > MAX_REFS) return err(400, `too many chunks (max ${MAX_REFS})`)
        let total = manifest.length
        const missing: string[] = []
        for (const name of refs) {
          const row = this.sql.exec<{ size: number }>('SELECT size FROM blobs WHERE name = ?', name).toArray()[0]
          if (!row) missing.push(name)
          else total += Number(row.size)
        }
        if (missing.length) return err(409, 'some chunks are missing, upload them first', { json: { error: 'some chunks are missing, upload them first', missing }, version })
        if (total > MAX_COMMITTED_BYTES) return err(413, `too large (max ${MAX_COMMITTED_BYTES} bytes)`, { version })
        const next = (version ?? 0) + 1
        this.h.transaction(() => {
          this.sql.exec('DELETE FROM chunks')
          this.sql.exec('DELETE FROM manifest')
          this.sql.exec('INSERT INTO manifest (i, data) VALUES (0, ?)', manifest)
          for (const name of refs) this.sql.exec('INSERT INTO refs (name, gen) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET gen = excluded.gen', name, next)
          // Pieces the old manifest used and the new one does not: no reader needs them now.
          this.sql.exec('DELETE FROM blobs WHERE name IN (SELECT name FROM refs WHERE gen < ?)', next)
          this.sql.exec('DELETE FROM refs WHERE gen < ?', next)
          this.dropOrphans(now)
          if (auth === null) this.setMeta('auth', tokenHash)
          this.setMeta('version', String(next))
          this.setMeta('format', '2')
          this.setMeta('updated', String(now))
        })
        await this.h.setAlarm(now + IDLE_TTL_MS)
        return { status: version === null ? 201 : 200, json: { version: next }, version: next }
      }
    }
  }

  /** Uploads that no commit used, older than a day (a sync that stopped half way). */
  private dropOrphans(now: number): void {
    this.sql.exec('DELETE FROM blobs WHERE created < ? AND name NOT IN (SELECT name FROM refs)', now - ORPHAN_TTL_MS)
  }

  private clash(ifs: Ifs, version: number | null): Result | null {
    if (version === null) {
      if (!ifs.ifNoneMatch) return err(409, 'vault does not exist yet', { json: { error: 'vault does not exist yet', version: null }, version: null })
      return null
    }
    if (ifs.ifNoneMatch || ifs.ifMatch !== version) {
      return { status: 409, json: { error: 'version changed, pull and merge first', version }, version }
    }
    return null
  }

  /** Remove a vault nobody used for a long time (or that never got a first commit). */
  async alarm(): Promise<void> {
    if (!this.exists()) return
    const updated = Number(this.meta('updated') ?? '0')
    const ttl = this.meta('version') === null ? PENDING_TTL_MS : IDLE_TTL_MS
    if (this.h.now() - updated >= ttl - 60_000) await this.h.deleteAll()
    else await this.h.setAlarm(updated + ttl)
  }

  /** For tests. */
  stats(): { blobs: number; refs: number; stored: number; format: number; version: number | null } {
    this.tables()
    const n = (q: string): number => Number(this.sql.exec<{ n: number }>(q).toArray()[0]?.n ?? 0)
    const v = this.meta('version')
    return { blobs: n('SELECT COUNT(*) AS n FROM blobs'), refs: n('SELECT COUNT(*) AS n FROM refs'), stored: this.storedBytes(), format: this.meta('format') === '2' ? 2 : 1, version: v === null ? null : Number(v) }
  }
}
