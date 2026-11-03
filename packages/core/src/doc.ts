import { bumpHlc, formatHlc, maxHlc, parseHlc, type Clock, type Hlc } from './hlc'
import { mergeText } from './text'

/** One record in the app, e.g. a journal entry. Every record has an id. */
export interface Item {
  id: string
  [field: string]: unknown
}

/** The app's data as plain lists: collection name -> items. */
export type Snapshot = Record<string, Item[]>

export interface Schema {
  /** Collections to sync, e.g. ['logs', 'labs']. */
  collections: string[]
  /** Text fields merged line by line, e.g. { logs: ['body'] }. Other fields use last-writer-wins. */
  textFields?: Record<string, string[]>
  /** Field that names an item, used for the "(conflict copy)" title. */
  titleField?: Record<string, string>
  /** Fields that stay on each device and are never sent, e.g. { settings: ['theme'] }. */
  localFields?: Record<string, string[]>
}

/**
 * [value, stamp] or [value, stamp, merged-from stamps].
 * The third part marks a text value that already contains the edits from those stamps.
 */
export type FieldEntry = [unknown, Hlc] | [unknown, Hlc, Hlc[]]

export interface DocItem {
  /** Fields, each with the stamp of its last change. */
  f: Record<string, FieldEntry>
  /** Set when the item was deleted (stamp of the delete). */
  d?: Hlc
}

/** The synced document: every field of every item with its own stamp. */
export interface Doc {
  v: 1
  /** Tombstones older than this stamp were removed. */
  gc?: Hlc
  c: Record<string, Record<string, DocItem>>
}

/** Deleted items are kept as tombstones for this long, then removed. */
export const TOMBSTONE_TTL_MS = 60 * 24 * 60 * 60 * 1000

export const CONFLICT_SUFFIX = ' (conflict copy)'

export function emptyDoc(): Doc {
  return { v: 1, c: {} }
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T

/** JSON with sorted keys, so two equal docs give the same string. */
export function stableStringify(x: unknown): string {
  if (x === undefined) return 'null'
  if (x === null || typeof x !== 'object') return JSON.stringify(x)
  if (Array.isArray(x)) return `[${x.map(stableStringify).join(',')}]`
  const o = x as Record<string, unknown>
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`
}

const same = (a: unknown, b: unknown): boolean => stableStringify(a) === stableStringify(b)

export function docsEqual(a: Doc | null, b: Doc | null): boolean {
  return stableStringify(a) === stableStringify(b)
}

function newestStamp(item: DocItem): Hlc | undefined {
  let m: Hlc | undefined = item.d
  for (const e of Object.values(item.f)) m = maxHlc(m, e[1])
  return m
}

function newestFieldStamp(item: DocItem): Hlc | undefined {
  let m: Hlc | undefined
  for (const e of Object.values(item.f)) m = maxHlc(m, e[1])
  return m
}

/** An item is shown if it was never deleted, or was edited after the delete. */
export function isVisible(item: DocItem): boolean {
  if (!item.d) return true
  const f = newestFieldStamp(item)
  return f !== undefined && f > item.d
}

/** Newest stamp anywhere in the doc (to move the local clock forward). */
export function newestInDoc(doc: Doc): Hlc | undefined {
  let m: Hlc | undefined = doc.gc
  for (const coll of Object.values(doc.c)) for (const item of Object.values(coll)) m = maxHlc(m, newestStamp(item))
  return m
}

/**
 * Compare the app's current data with the last synced doc (`base`) and
 * stamp every field that changed. Items missing from the app become tombstones.
 */
export function stamp(base: Doc | null, snap: Snapshot, clock: Clock, schema: Schema): Doc {
  const doc = base ? clone(base) : emptyDoc()
  for (const coll of schema.collections) {
    const local = new Set(schema.localFields?.[coll] ?? [])
    const items = (doc.c[coll] ??= {})
    const seen = new Set<string>()
    for (const it of snap[coll] ?? []) {
      if (!it || typeof it.id !== 'string' || seen.has(it.id)) continue
      seen.add(it.id)
      let t: Hlc | undefined
      const tick = (): Hlc => (t ??= clock.tick())
      const fields = Object.keys(it).filter((k) => k !== 'id' && !local.has(k) && it[k] !== undefined)
      const ex = items[it.id]
      if (!ex || !isVisible(ex)) {
        // New item, or one that was deleted and added again: stamp every field.
        const f: Record<string, FieldEntry> = ex ? clone(ex.f) : {}
        for (const k of Object.keys(f)) if (!fields.includes(k) && !local.has(k)) f[k] = [null, tick()]
        for (const k of fields) f[k] = [it[k], tick()]
        items[it.id] = ex?.d ? { f, d: ex.d } : { f }
        continue
      }
      const keys = new Set([...fields, ...Object.keys(ex.f).filter((k) => !local.has(k))])
      for (const k of keys) {
        const v = it[k] === undefined ? null : it[k]
        const old = ex.f[k]
        if (!old ? v !== null : !same(old[0], v)) ex.f[k] = [v, tick()]
      }
    }
    for (const [id, ex] of Object.entries(items)) {
      if (!seen.has(id) && isVisible(ex)) ex.d = clock.tick()
    }
  }
  return doc
}

function shortHash(s: string): string {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return (h >>> 0).toString(36)
}

export interface MergeResult {
  doc: Doc
  /** Number of conflict copies made. */
  conflicts: number
}

/**
 * Merge two docs. `base` is the last doc this device synced (the common
 * ancestor). The result is the same whichever side is passed as `a` or `b`.
 */
export function merge(a: Doc, b: Doc, base: Doc | null, schema: Schema, now: number = Date.now()): MergeResult {
  const out: Doc = { v: 1, c: {} }
  const gc = maxHlc(a.gc, b.gc)
  if (gc) out.gc = gc
  let conflicts = 0
  const colls = new Set([...Object.keys(a.c), ...Object.keys(b.c)])
  for (const coll of colls) {
    const ca = a.c[coll] ?? {}
    const cb = b.c[coll] ?? {}
    const cbase = base?.c[coll] ?? {}
    const texts = new Set(schema.textFields?.[coll] ?? [])
    const res: Record<string, DocItem> = {}
    const ids = [...new Set([...Object.keys(ca), ...Object.keys(cb)])].sort()
    for (const id of ids) {
      const ia = ca[id]
      const ib = cb[id]
      if (!ia || !ib) {
        const only = (ia ?? ib) as DocItem
        const otherGc = ia ? b.gc : a.gc
        const s = newestStamp(only)
        // The other side removed this tombstone in a cleanup, and nothing changed here since.
        if (cbase[id] && otherGc && s !== undefined && s <= otherGc) continue
        res[id] = clone(only)
        continue
      }
      const item: DocItem = { f: {} }
      const d = maxHlc(ia.d, ib.d)
      if (d) item.d = d
      const keys = [...new Set([...Object.keys(ia.f), ...Object.keys(ib.f)])].sort()
      for (const k of keys) {
        const ea = ia.f[k]
        const eb = ib.f[k]
        if (!ea || !eb) {
          item.f[k] = clone((ea ?? eb) as FieldEntry)
          continue
        }
        if (ea[1] === eb[1]) {
          item.f[k] = clone(ea[1] === eb[1] && (ea[2]?.length ?? 0) >= (eb[2]?.length ?? 0) ? ea : eb)
          continue
        }
        const [win, lose] = ea[1] > eb[1] ? [ea, eb] : [eb, ea]
        const baseEntry = cbase[id]?.f[k]
        const bothChanged = baseEntry?.[1] !== ea[1] && baseEntry?.[1] !== eb[1]
        const already = win[2]?.includes(lose[1]) ?? false
        if (
          texts.has(k) &&
          bothChanged &&
          !already &&
          typeof win[0] === 'string' &&
          typeof lose[0] === 'string' &&
          win[0] !== lose[0]
        ) {
          const baseText = typeof baseEntry?.[0] === 'string' ? (baseEntry[0] as string) : ''
          const m = mergeText(baseText, win[0], lose[0])
          if (!m.conflict) {
            const from = [...new Set([...(win[2] ?? []), win[1], lose[1], ...(lose[2] ?? [])])].sort()
            item.f[k] = [m.text, bumpHlc(win[1]), from]
            continue
          }
          // Both changed the same lines: keep the newer text here and the other one in a copy.
          const loserItem = lose === ea ? ia : ib
          const copyId = `${id}~c${shortHash(lose[1])}`
          if (!ca[copyId] && !cb[copyId] && !res[copyId]) {
            const f: Record<string, FieldEntry> = {}
            for (const [fk, fe] of Object.entries(loserItem.f)) f[fk] = [clone(fe[0]), lose[1]]
            f[k] = [lose[0], lose[1]]
            const tf = schema.titleField?.[coll]
            if (tf && typeof f[tf]?.[0] === 'string' && !(f[tf][0] as string).endsWith(CONFLICT_SUFFIX)) {
              f[tf] = [(f[tf][0] as string) + CONFLICT_SUFFIX, lose[1]]
            }
            res[copyId] = { f }
            conflicts++
          }
        }
        item.f[k] = clone(win)
      }
      res[id] = item
    }
    out.c[coll] = res
  }
  return { doc: collectGarbage(out, now), conflicts }
}

/** Remove tombstones older than the TTL and remember the cutoff. */
export function collectGarbage(doc: Doc, now: number = Date.now()): Doc {
  const cutoff = formatHlc({ wall: Math.max(0, now - TOMBSTONE_TTL_MS), counter: 36 ** 4 - 1, device: '~' })
  let removed = false
  for (const coll of Object.values(doc.c)) {
    for (const [id, item] of Object.entries(coll)) {
      const s = newestStamp(item)
      if (!isVisible(item) && s !== undefined && s <= cutoff) {
        delete coll[id]
        removed = true
      }
    }
  }
  if (removed) doc.gc = maxHlc(doc.gc, cutoff)
  return doc
}

/** Visible items as plain objects (cleared fields are left out). */
export function toSnapshot(doc: Doc, schema: Schema): Snapshot {
  const snap: Snapshot = {}
  for (const coll of schema.collections) {
    const list: Item[] = []
    for (const [id, item] of Object.entries(doc.c[coll] ?? {})) {
      if (!isVisible(item)) continue
      const it: Item = { id }
      for (const [k, e] of Object.entries(item.f)) if (e[0] !== null) it[k] = clone(e[0])
      list.push(it)
    }
    snap[coll] = list
  }
  return snap
}

/** Check that unknown JSON looks like a Doc. */
export function isDoc(x: unknown): x is Doc {
  if (!x || typeof x !== 'object') return false
  const d = x as Doc
  if (d.v !== 1 || !d.c || typeof d.c !== 'object') return false
  for (const coll of Object.values(d.c)) {
    if (!coll || typeof coll !== 'object') return false
    for (const item of Object.values(coll)) {
      if (!item || typeof item !== 'object' || !item.f || typeof item.f !== 'object') return false
      for (const e of Object.values(item.f)) if (!Array.isArray(e) || typeof e[1] !== 'string') return false
    }
  }
  return true
}

export { parseHlc }
