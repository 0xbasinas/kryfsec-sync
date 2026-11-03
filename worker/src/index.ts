/**
 * kryfsec sync server.
 *
 * Stores encrypted data per vault. It never sees the sync key, the encryption
 * key or the plain data, and it never logs request bodies.
 *
 *   GET    /health
 *
 *   Format 2 (chunked, current apps):
 *   GET    /v2/vault/:id              -> 200 encrypted manifest, ETag, x-vault-format: 2
 *                                        (or the old blob with x-vault-format: 1), 404 if none
 *   POST   /v2/vault/:id/chunks       -> upload pieces: [16-byte name][u32 length][data]...
 *   POST   /v2/vault/:id/chunks/read  -> {"names": [...]} -> the same packed format
 *   PUT    /v2/vault/:id              -> {"manifest": base64, "refs": [...]} with If-Match / If-None-Match: *
 *                                        409 on a version clash or missing pieces
 *   DELETE /v2/vault/:id              -> 204
 *
 *   Format 1 (old apps, one blob, max 4 MB): GET / PUT / DELETE /v1/vault/:id.
 *   Returns 410 "please update" once a newer app upgraded the vault.
 *
 * Every vault request needs "Authorization: Bearer <token>". The first write
 * saves a SHA-256 hash of the token; later requests must send the same token.
 */
import { DurableObject } from 'cloudflare:workers'
import { Limiter, route, VAULT_PER_MIN } from './router'
import { VaultStore, type Op, type Result, type SqlLike } from './store'

export interface Env {
  VAULTS: DurableObjectNamespace<Vault>
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    return route(req, (id) => env.VAULTS.get(env.VAULTS.idFromName(id)) as unknown as { handle(t: string, op: Op): Promise<Result> })
  }
} satisfies ExportedHandler<Env>

/** One Durable Object per vault, so writes to a vault happen one at a time. */
export class Vault extends DurableObject<Env> {
  private store: VaultStore
  private limiter = new Limiter(VAULT_PER_MIN)

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    const storage = ctx.storage
    this.store = new VaultStore({
      sql: storage.sql as unknown as SqlLike,
      transaction: (fn) => storage.transactionSync(fn),
      deleteAll: () => storage.deleteAll(),
      setAlarm: (at) => storage.setAlarm(at),
      getAlarm: () => storage.getAlarm(),
      deleteAlarm: () => storage.deleteAlarm(),
      now: () => Date.now()
    })
  }

  async handle(tokenHash: string, op: Op): Promise<Result> {
    if (!this.limiter.allow('v')) return { status: 429, json: { error: 'too many requests' }, headers: { 'retry-after': '60' } }
    return this.store.handle(tokenHash, op)
  }

  async alarm(): Promise<void> {
    await this.store.alarm()
  }
}
