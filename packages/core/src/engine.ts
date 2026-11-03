import { decryptJson, encryptJson, type VaultKeys } from './crypto'
import { docsEqual, isDoc, merge, newestInDoc, stableStringify, stamp, toSnapshot, collectGarbage, type Doc, type Schema, type Snapshot } from './doc'
import { Clock, type Hlc } from './hlc'
import type { Transport } from './transport'

/** What a device remembers between syncs (not secret, but keep it with the app data). */
export interface SyncState {
  device: string
  vaultId: string
  /** Last clock value, so stamps keep going up after a restart. */
  clock?: Hlc
  /** The doc as it was on the server after the last sync (the merge base). */
  base: Doc | null
  /** `base` plus this device's edits, each stamped when it was recorded. */
  local?: Doc | null
  /** Server version of `base`. */
  version: number | null
  /** Time of the last good sync (ms). */
  lastSync?: number
}

export interface SyncDeps {
  schema: Schema
  keys: VaultKeys
  transport: Transport
  state: SyncState
  saveState: (s: SyncState) => Promise<void> | void
  /** Current app data. */
  read: () => Snapshot
  /** Replace the app data with the merged result. */
  write: (s: Snapshot) => void
  /**
   * First sync on a device that joins an existing vault: drop what should not
   * be merged in (for example the app's sample data).
   */
  onJoin?: (s: Snapshot) => Snapshot
  now?: () => number
}

export interface SyncResult {
  pushed: boolean
  pulled: boolean
  conflicts: number
  version: number
  /** Edits came in while syncing; run sync again soon. */
  dirty: boolean
}

const MAX_TRIES = 5

/**
 * Stamp local edits now, without the network (call it after each save).
 * Edits made offline then keep the time they were made, not the time of the next sync.
 * Does nothing before the first sync.
 */
export async function recordLocalEdits(deps: Pick<SyncDeps, 'schema' | 'state' | 'saveState' | 'read' | 'now'>): Promise<void> {
  const state = deps.state
  if (!state.base) return
  const clock = new Clock(state.device, state.clock, deps.now ?? Date.now)
  const prev = state.local ?? state.base
  const next = stamp(prev, deps.read(), clock, deps.schema)
  if (docsEqual(next, prev)) return
  state.local = next
  state.clock = clock.last()
  await deps.saveState({ ...state })
}

export async function syncOnce(deps: SyncDeps): Promise<SyncResult> {
  const now = deps.now ?? Date.now
  const { schema, keys, transport } = deps
  const state = deps.state
  const clock = new Clock(state.device, state.clock, now)
  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    const remote = await transport.get()
    let remoteDoc: Doc | null = null
    if (remote) {
      const raw = decryptJson(keys, remote.body)
      if (!isDoc(raw)) throw new Error('Sync data on the server is not valid')
      remoteDoc = raw
      const newest = newestInDoc(remoteDoc)
      if (newest) clock.observe(newest)
    }
    const joining = state.base === null && remoteDoc !== null
    const readNow = (): Snapshot => (joining && deps.onJoin ? deps.onJoin(deps.read()) : deps.read())

    // No awaits from here until the PUT, so the snapshot and the merge match.
    const snap = readNow()
    const snapKey = stableStringify(snap)
    const localDoc = stamp(state.local ?? state.base, snap, clock, schema)
    let conflicts = 0
    let merged: Doc
    if (remoteDoc) {
      const m = merge(localDoc, remoteDoc, state.base, schema, now())
      merged = m.doc
      conflicts = m.conflicts
    } else {
      merged = collectGarbage(localDoc, now())
    }

    let version = remote?.version ?? 0
    let pushed = false
    if (!remoteDoc || !docsEqual(merged, remoteDoc)) {
      const res = await transport.put(encryptJson(keys, merged), remote ? remote.version : null)
      if (!res.ok) continue // someone else wrote first: pull again and merge
      version = res.version
      pushed = true
    }

    // Edits made while we were waiting on the network are kept on top.
    const current = readNow()
    let final = merged
    let dirty = false
    if (stableStringify(current) !== snapKey) {
      const edits = stamp(localDoc, current, clock, schema)
      final = merge(edits, merged, localDoc, schema, now()).doc
      dirty = true
    }
    const before = stableStringify(current)
    const result = toSnapshot(final, schema)
    const pulled = joining || stableStringify(result) !== before
    if (pulled) deps.write(result)

    const next: SyncState = { ...state, base: merged, local: final, version, clock: clock.last(), lastSync: now() }
    Object.assign(state, next)
    await deps.saveState(next)
    return { pushed, pulled, conflicts, version, dirty }
  }
  throw new Error('Sync kept clashing with another device. Try again.')
}

/** Delete this vault on the server (all devices lose the server copy). */
export async function deleteVault(transport: Transport): Promise<void> {
  await transport.remove()
}
