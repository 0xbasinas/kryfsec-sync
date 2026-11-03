import { assembleDoc, buildLayout, canonDoc, isManifest, sameManifest, type Manifest } from './chunks'
import { AAD, decryptJson, encryptJson, type VaultKeys } from './crypto'
import { docsEqual, isDoc, merge, newestInDoc, stableStringify, stamp, toSnapshot, collectGarbage, type Doc, type Schema, type Snapshot } from './doc'
import { Clock, type Hlc } from './hlc'
import { MAX_VAULT_BYTES, SyncHttpError, type Transport } from './transport'

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
  /** The server's chunk list for `base`, so unchanged parts are not downloaded again. */
  manifest?: Manifest | null
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
  /** Pieces downloaded and uploaded in this sync. */
  fetched: number
  uploaded: number
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
  const sent = new Set<string>()
  let fetched = 0
  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    const remote = await transport.get()
    let remoteDoc: Doc | null = null
    let remoteManifest: Manifest | null = null
    if (remote?.format === 1) {
      // Old single-blob vault: read it, and the push below upgrades it.
      const raw = decryptJson(keys, remote.body, AAD.blob(keys.vaultId))
      if (!isDoc(raw)) throw new Error('Sync data on the server is not valid')
      remoteDoc = canonDoc(raw)
    } else if (remote) {
      const raw = decryptJson(keys, remote.body, AAD.manifest(keys.vaultId))
      if (!isManifest(raw)) throw new Error('Sync data on the server is not valid')
      remoteManifest = raw
      const base = state.base && state.manifest ? { doc: state.base, manifest: state.manifest } : null
      const got = await assembleDoc(keys, raw, base, (names) => transport.readChunks(names))
      fetched += got.fetched
      remoteDoc = got.doc
    }
    if (remoteDoc) {
      const newest = newestInDoc(remoteDoc)
      if (newest) clock.observe(newest)
    }
    const joining = state.base === null && remoteDoc !== null
    const remoteSnap = joining && remoteDoc ? toSnapshot(remoteDoc, schema) : null
    const readNow = (): Snapshot => (remoteSnap ? joinView(deps.onJoin ? deps.onJoin(deps.read()) : deps.read(), remoteSnap) : deps.read())

    // No awaits between reading the app data and merging, so the two match.
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
    merged = canonDoc(merged)

    let version = remote?.version ?? 0
    let pushed = false
    let manifest: Manifest | null = remoteManifest
    const layout = buildLayout(keys, merged, remoteManifest)
    if (!remote || remote.format === 1 || !sameManifest(layout.manifest, remoteManifest)) {
      const total = layout.manifest.b.reduce((s, b) => s + b.p.reduce((t, p) => t + p[1], 0), 0)
      if (total > MAX_VAULT_BYTES) throw new SyncHttpError(413, 'Your data is too big to sync')
      const uploads = layout.uploads.filter((u) => !sent.has(u.name))
      await transport.writeChunks(uploads)
      for (const u of uploads) sent.add(u.name)
      const res = await transport.commit(encryptJson(keys, layout.manifest, AAD.manifest(keys.vaultId)), layout.refs, remote ? remote.version : null)
      if (!res.ok) {
        // Someone else wrote first, or the server lost an upload: pull again and merge.
        for (const name of res.missing ?? []) sent.delete(name)
        continue
      }
      version = res.version
      manifest = layout.manifest
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

    const next: SyncState = { ...state, base: merged, local: final, version, manifest, clock: clock.last(), lastSync: now() }
    Object.assign(state, next)
    await deps.saveState(next)
    return { pushed, pulled, conflicts, version, dirty, fetched, uploaded: sent.size }
  }
  throw new Error('Sync kept clashing with another device. Try again.')
}

/**
 * First sync on a joining device: for items both sides have (like the single
 * settings item), the vault's values win. This device's own items are added.
 */
function joinView(local: Snapshot, remote: Snapshot): Snapshot {
  const out: Snapshot = {}
  for (const [coll, list] of Object.entries(local)) {
    const theirs = new Map((remote[coll] ?? []).map((x) => [x.id, x]))
    out[coll] = list.map((it) => (theirs.has(it.id) ? { ...it, ...theirs.get(it.id)! } : it))
  }
  return out
}

/** Delete this vault on the server (all devices lose the server copy). */
export async function deleteVault(transport: Transport): Promise<void> {
  await transport.remove()
}
