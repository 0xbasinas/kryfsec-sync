/**
 * The real Worker code (router + vault store) running on Node's SQLite,
 * as an HttpFn the sync code can talk to. One SQLite database per vault,
 * like one Durable Object per vault.
 */
import { DatabaseSync } from 'node:sqlite'
import { Limiter, route } from '../../../worker/src/router'
import { VaultStore, type Op, type Result, type StoreHost } from '../../../worker/src/store'
import type { HttpFn } from '../src/transport'

class SqliteHost implements StoreHost {
  db = new DatabaseSync(':memory:')
  alarmAt: number | null = null
  constructor(readonly now: () => number) {}
  sql = {
    exec: <T>(q: string, ...b: unknown[]) => {
      const rows = this.db.prepare(q).all(...b) as T[]
      return { toArray: () => rows }
    }
  }
  transaction(fn: () => void): void {
    this.db.exec('BEGIN')
    try {
      fn()
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }
  async deleteAll(): Promise<void> {
    for (const t of ['meta', 'chunks', 'blobs', 'refs', 'manifest']) this.db.exec(`DROP TABLE IF EXISTS ${t}`)
    this.alarmAt = null
  }
  async setAlarm(at: number): Promise<void> {
    this.alarmAt = at
  }
  async getAlarm(): Promise<number | null> {
    return this.alarmAt
  }
  async deleteAlarm(): Promise<void> {
    this.alarmAt = null
  }
}

export interface Call {
  method: string
  path: string
  sent: number
  received: number
}

export class TestServer {
  now: () => number = () => Date.now()
  online = true
  calls: Call[] = []
  /** Runs once before the next commit is checked (to fake another device writing first). */
  beforeCommit: (() => Promise<void>) | null = null
  commits = 0
  private vaults = new Map<string, { host: SqliteHost; store: VaultStore }>()
  private limiter = new Limiter(1e9)

  vault(id: string): { host: SqliteHost; store: VaultStore } {
    let v = this.vaults.get(id)
    if (!v) {
      const host = new SqliteHost(() => this.now())
      v = { host, store: new VaultStore(host) }
      this.vaults.set(id, v)
    }
    return v
  }

  /** Vaults that hold anything. */
  get size(): number {
    return [...this.vaults.values()].filter((v) => {
      const s = v.store.stats()
      return s.version !== null || s.blobs > 0
    }).length
  }

  http: HttpFn = async (req) => {
    if (!this.online) throw new (await import('../src/transport')).SyncNetworkError()
    const res = await route(
      new Request(req.url, { method: req.method, headers: req.headers, body: req.body as BodyInit | undefined }),
      (id) => ({
        handle: async (token: string, op: Op): Promise<Result> => {
          if (op.op === 'commit' && this.beforeCommit) {
            const hook = this.beforeCommit
            this.beforeCommit = null
            await hook()
          }
          const r = await this.vault(id).store.handle(token, op)
          if (op.op === 'commit' && r.status < 300) this.commits++
          return r
        }
      }),
      this.limiter
    )
    const body = new Uint8Array(await res.arrayBuffer())
    const headers: Record<string, string> = {}
    res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v))
    this.calls.push({ method: req.method, path: new URL(req.url).pathname, sent: req.body?.length ?? 0, received: body.length })
    return { status: res.status, headers, body }
  }

  /** How many requests matched, since the list was last cleared. */
  count(method: string, pathEnd: string): number {
    return this.calls.filter((c) => c.method === method && c.path.endsWith(pathEnd)).length
  }
}
