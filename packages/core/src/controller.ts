import { deriveKeys, formatSyncKey, generateSyncKey, newDeviceId, parseSyncKey, type VaultKeys } from './crypto'
import type { Schema, Snapshot } from './doc'
import { recordLocalEdits, syncOnce, type SyncResult, type SyncState } from './engine'
import { httpTransport, SyncHttpError, SyncNetworkError, type HttpFn, type Transport } from './transport'

/** Where an app keeps the key (secret) and the sync state (not secret). */
export interface SyncStorage {
  loadKey(): Promise<string | null>
  saveKey(key: string | null): Promise<void>
  loadState(): Promise<SyncState | null>
  saveState(state: SyncState | null): Promise<void>
}

export interface SyncStatus {
  paired: boolean
  busy: boolean
  /** Time of the last good sync (ms). */
  lastSync?: number
  /** Short, user-facing problem. */
  error?: string
  offline: boolean
  /** Conflict copies made by the last sync. */
  conflicts: number
}

export interface ControllerOptions {
  http: HttpFn
  baseUrl?: string
  storage: SyncStorage
  schema: Schema
  read: () => Snapshot
  write: (s: Snapshot) => void
  onJoin?: (s: Snapshot) => Snapshot
  /** Wait this long after the last edit before syncing. */
  editDelayMs?: number
  /** Retry after this long when offline or on an error. */
  retryMs?: number
}

/** Runs sync for an app: one at a time, after edits, and again when needed. */
export class SyncController {
  private key: Uint8Array | null = null
  private keys: VaultKeys | null = null
  private transport: Transport | null = null
  private state: SyncState | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private running: Promise<SyncResult | null> | null = null
  private again = false
  private editTimer: ReturnType<typeof setTimeout> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private listeners = new Set<(s: SyncStatus) => void>()
  status: SyncStatus = { paired: false, busy: false, offline: false, conflicts: 0 }

  constructor(private opts: ControllerOptions) {}

  /** Load the saved key and state. Call once at start. */
  async init(): Promise<SyncStatus> {
    const text = await this.opts.storage.loadKey().catch(() => null)
    const key = text ? parseSyncKey(text) : null
    if (key) {
      this.use(key)
      const saved = await this.opts.storage.loadState().catch(() => null)
      this.state = saved && saved.vaultId === this.keys!.vaultId ? saved : this.freshState()
    }
    this.set({ paired: !!key, lastSync: this.state?.lastSync })
    return this.status
  }

  /** Make a new sync key on this device (the first device). Returns the key text. */
  async create(): Promise<string> {
    const key = generateSyncKey()
    await this.pair(key)
    return formatSyncKey(key)
  }

  /** Join with a key from another device. Throws if the key is not valid. */
  async join(text: string): Promise<void> {
    const key = parseSyncKey(text)
    if (!key) throw new Error('That sync key is not valid. Check it and try again.')
    await this.pair(key)
  }

  /** Forget the key on this device. Local data stays. The server copy stays for other devices. */
  async unpair(): Promise<void> {
    this.clearTimers()
    await this.queue.catch(() => undefined)
    this.key = this.keys = this.transport = this.state = null
    await this.opts.storage.saveKey(null)
    await this.opts.storage.saveState(null)
    this.set({ paired: false, busy: false, lastSync: undefined, error: undefined, offline: false, conflicts: 0 })
  }

  /** The key as text, to show again (QR or copy). */
  keyText(): string | null {
    return this.key ? formatSyncKey(this.key) : null
  }

  /** Sync now. If a sync is running, one more runs after it. */
  syncNow(): Promise<SyncResult | null> {
    if (!this.transport) return Promise.resolve(null)
    if (this.running) {
      this.again = true
      return this.running
    }
    if (this.editTimer) clearTimeout(this.editTimer)
    this.editTimer = null
    this.running = this.run().finally(() => {
      this.running = null
      if (this.again) {
        this.again = false
        void this.syncNow()
      }
    })
    return this.running
  }

  /** Call after the app saves. Stamps the edits now and syncs a bit later. */
  noteEdit(): void {
    if (!this.transport || !this.state) return
    const state = this.state
    this.queue = this.queue
      .then(() => (this.state === state ? recordLocalEdits({ schema: this.opts.schema, state, saveState: (s) => this.opts.storage.saveState(s), read: this.opts.read }) : undefined))
      .catch(() => undefined)
    if (this.editTimer) clearTimeout(this.editTimer)
    this.editTimer = setTimeout(() => void this.syncNow(), this.opts.editDelayMs ?? 4000)
  }

  subscribe(fn: (s: SyncStatus) => void): () => void {
    this.listeners.add(fn)
    fn(this.status)
    return () => this.listeners.delete(fn)
  }

  dispose(): void {
    this.clearTimers()
    this.listeners.clear()
  }

  private async pair(key: Uint8Array): Promise<void> {
    this.clearTimers()
    await this.queue.catch(() => undefined)
    this.use(key)
    this.state = this.freshState()
    await this.opts.storage.saveKey(formatSyncKey(key))
    await this.opts.storage.saveState(this.state)
    this.set({ paired: true, lastSync: undefined, error: undefined, offline: false, conflicts: 0 })
    await this.syncNow()
  }

  private use(key: Uint8Array): void {
    this.key = key
    this.keys = deriveKeys(key)
    this.transport = httpTransport({ baseUrl: this.opts.baseUrl, keys: this.keys, http: this.opts.http })
  }

  private freshState(): SyncState {
    return { device: newDeviceId(), vaultId: this.keys!.vaultId, base: null, version: null }
  }

  private run(): Promise<SyncResult | null> {
    const job = this.queue.then(async () => {
      const { keys, transport, state } = this
      if (!keys || !transport || !state) return null
      if (this.retryTimer) clearTimeout(this.retryTimer)
      this.retryTimer = null
      this.set({ busy: true })
      try {
        const res = await syncOnce({
          schema: this.opts.schema,
          keys,
          transport,
          state,
          saveState: (s) => this.opts.storage.saveState(s),
          read: this.opts.read,
          write: this.opts.write,
          onJoin: this.opts.onJoin
        })
        if (this.state !== state) return null // unpaired or re-paired meanwhile
        this.set({ busy: false, lastSync: state.lastSync, error: undefined, offline: false, conflicts: res.conflicts })
        if (res.dirty) this.again = true
        return res
      } catch (err) {
        if (this.state !== state) return null
        const offline = err instanceof SyncNetworkError
        this.set({ busy: false, offline, error: offline ? undefined : explain(err) })
        this.retryTimer = setTimeout(() => void this.syncNow(), this.opts.retryMs ?? (offline ? 60_000 : 5 * 60_000))
        return null
      }
    })
    this.queue = job.catch(() => undefined)
    return job
  }

  private clearTimers(): void {
    if (this.editTimer) clearTimeout(this.editTimer)
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.editTimer = this.retryTimer = null
  }

  private set(p: Partial<SyncStatus>): void {
    this.status = { ...this.status, ...p }
    for (const fn of this.listeners) fn(this.status)
  }
}

function explain(err: unknown): string {
  if (err instanceof SyncHttpError) {
    if (err.status === 401) return 'The server did not accept this key.'
    if (err.status === 413) return 'Your data is too big to sync (over 4 MB).'
    if (err.status === 429) return 'Too many syncs. It will try again soon.'
    if (err.status >= 500) return 'The sync server had a problem. It will try again soon.'
    return err.message
  }
  const msg = err instanceof Error ? err.message : String(err)
  if (/tag|decrypt|invalid ghash|aes/i.test(msg)) return 'Could not unlock the synced data with this key.'
  return msg || 'Sync failed.'
}

/** "just now", "2 min ago", "3 h ago", "4 days ago". */
export function timeAgo(ms: number | undefined, now = Date.now()): string {
  if (!ms) return 'never'
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.round(h / 24)
  return d === 1 ? '1 day ago' : `${d} days ago`
}
