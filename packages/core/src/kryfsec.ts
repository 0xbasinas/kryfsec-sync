import type { Item, Schema, Snapshot } from './doc'

/** The kryfsec app data, as far as sync cares. */
export interface KryfsecData {
  settings: Record<string, unknown>
  areas: Item[]
  topics: Item[]
  logs: Item[]
  resources: Item[]
  labs: Item[]
  certs: Item[]
  goals: Item[]
}

const LISTS = ['areas', 'topics', 'logs', 'resources', 'labs', 'certs', 'goals'] as const

export const KRYFSEC_SCHEMA: Schema = {
  collections: ['settings', ...LISTS],
  textFields: {
    logs: ['body'],
    labs: ['writeup'],
    topics: ['notes'],
    resources: ['notes'],
    certs: ['notes'],
    areas: ['description']
  },
  titleField: {
    logs: 'title',
    labs: 'name',
    topics: 'title',
    resources: 'title',
    certs: 'name',
    goals: 'title',
    areas: 'name'
  },
  // Each device keeps its own theme.
  localFields: { settings: ['theme'] }
}

/** App data -> sync snapshot. Settings become one item with id "settings". */
export function appToSnapshot(data: KryfsecData): Snapshot {
  const snap: Snapshot = { settings: [{ ...data.settings, id: 'settings' }] }
  for (const k of LISTS) snap[k] = (data[k] ?? []).map((x) => ({ ...x }))
  return snap
}

/**
 * Sync snapshot -> app data. Keeps the order the device already had for
 * existing items and puts new items first (lists in kryfsec are newest first).
 */
export function snapshotToApp<T extends KryfsecData>(snap: Snapshot, current: T): T {
  const next = { ...current }
  const s = snap.settings?.find((x) => x.id === 'settings')
  if (s) {
    const { id: _id, ...rest } = s
    void _id
    const keep: Record<string, unknown> = {}
    for (const f of KRYFSEC_SCHEMA.localFields?.settings ?? []) if (f in current.settings) keep[f] = current.settings[f]
    next.settings = { ...current.settings, ...rest, ...keep }
  }
  for (const k of LISTS) {
    const incoming = new Map((snap[k] ?? []).map((x) => [x.id, x]))
    const kept: Item[] = []
    for (const old of current[k] ?? []) {
      const it = incoming.get(old.id)
      if (it) {
        kept.push(it)
        incoming.delete(old.id)
      }
    }
    ;(next as KryfsecData)[k] = [...incoming.values(), ...kept]
  }
  return next
}

/**
 * Used the first time a device joins a vault that already has data:
 * drop this device's starter roadmap and examples (items marked `sample`),
 * so they are not added twice. Things you made yourself are kept.
 */
export function dropSamples(snap: Snapshot): Snapshot {
  const out: Snapshot = {}
  for (const [k, list] of Object.entries(snap)) out[k] = k === 'settings' ? list : list.filter((x) => !x.sample)
  return out
}
