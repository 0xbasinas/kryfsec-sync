/**
 * Chunked storage of the synced doc (format 2).
 *
 * The doc is split into buckets by a hash of each record's collection and id.
 * Each bucket is JSON -> gzip -> cut into pieces of at most PART_BYTES -> each
 * piece encrypted on its own. A piece is named by an HMAC of its content (like
 * borg's chunk ids), so the name says nothing about what is inside, and a piece
 * that did not change keeps its name and is not uploaded again.
 *
 * A small encrypted manifest lists, for each bucket, a keyed hash of its JSON
 * and the names of its pieces. Committing a new manifest is the one atomic step
 * (with If-Match), so readers always see a complete, matching set of pieces.
 */
import { AAD, chunkName, decryptBytes, encryptBytes, gunzip, gzip, strFromU8, strToU8, type VaultKeys } from './crypto'
import { stableStringify, type Doc, type DocItem } from './doc'

/** Most gzipped bytes in one piece (before encryption). */
export const PART_BYTES = 512 * 1024
/** Aim for about this much JSON per bucket, so a bucket is usually one piece and an edit re-uploads one piece. */
export const BUCKET_TARGET = 256 * 1024
export const MIN_BUCKETS = 8
export const MAX_BUCKETS = 4096

/** [name, encrypted size in bytes] */
export type Part = [string, number]
export interface BucketRef {
  /** Keyed hash of the bucket's JSON ('' when the bucket is empty). */
  h: string
  p: Part[]
}
export interface Manifest {
  v: 2
  /** Number of buckets (a power of two). */
  n: number
  gc?: string
  b: BucketRef[]
}

export type Bucket = Record<string, Record<string, DocItem>>

/** FNV-1a, then a final mix so the low bits spread well. Same on every device. */
function hash32(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

/** Which bucket a record goes to. Only depends on the collection, the id and n. */
export function bucketOf(coll: string, id: string, n: number): number {
  return hash32(`${coll}\u0000${id}`) & (n - 1)
}

const nextPow2 = (x: number): number => 2 ** Math.ceil(Math.log2(Math.max(1, x)))

/**
 * How many buckets to use. Grows with the data; keeps the old count when it is
 * close, so pieces are not reshuffled on every small change.
 */
export function chooseBuckets(doc: Doc, prev?: number): number {
  const size = JSON.stringify(doc.c).length
  let n = Math.min(MAX_BUCKETS, Math.max(MIN_BUCKETS, nextPow2(Math.ceil(size / BUCKET_TARGET))))
  if (prev && prev >= MIN_BUCKETS && prev <= MAX_BUCKETS && prev > n && prev < n * 8) n = prev
  return n
}

export function splitDoc(doc: Doc, n: number): Bucket[] {
  const out: Bucket[] = Array.from({ length: n }, () => ({}))
  for (const [coll, items] of Object.entries(doc.c)) {
    for (const [id, item] of Object.entries(items)) {
      const b = out[bucketOf(coll, id, n)]
      ;(b[coll] ??= {})[id] = item
    }
  }
  return out
}

/** Drop empty collections, so the same data always looks the same. */
export function canonDoc(doc: Doc): Doc {
  const c: Doc['c'] = {}
  for (const [coll, items] of Object.entries(doc.c)) if (Object.keys(items).length) c[coll] = items
  const out: Doc = { v: 1, c }
  if (doc.gc) out.gc = doc.gc
  return out
}

export interface Upload {
  name: string
  data: Uint8Array
}

export interface Layout {
  manifest: Manifest
  /** Pieces the server does not have yet. */
  uploads: Upload[]
  /** Every piece the manifest uses. */
  refs: string[]
}

/**
 * Cut a doc into encrypted pieces. Buckets whose JSON hash matches `have`
 * (the manifest already on the server) reuse its pieces and are not uploaded.
 */
export function buildLayout(keys: VaultKeys, doc: Doc, have: Manifest | null, n = chooseBuckets(doc, have?.n)): Layout {
  const buckets = splitDoc(doc, n)
  const uploads = new Map<string, Uint8Array>()
  const b: BucketRef[] = buckets.map((bucket, i) => {
    if (Object.keys(bucket).length === 0) return { h: '', p: [] }
    const json = stableStringify(bucket)
    const h = chunkName(keys, json)
    const old = have && have.n === n ? have.b[i] : undefined
    if (old && old.h === h) return { h, p: old.p.map((x) => [...x] as Part) }
    const gz = gzip(strToU8(json))
    const p: Part[] = []
    for (let o = 0; o < gz.length; o += PART_BYTES) {
      const piece = gz.subarray(o, o + PART_BYTES)
      const name = chunkName(keys, piece)
      const data = uploads.get(name) ?? encryptBytes(keys, piece, AAD.chunk(keys.vaultId, name))
      uploads.set(name, data)
      p.push([name, data.length])
    }
    return { h, p }
  })
  const manifest: Manifest = { v: 2, n, b }
  if (doc.gc) manifest.gc = doc.gc
  const refs = [...new Set(b.flatMap((x) => x.p.map((p) => p[0])))]
  const haveNames = new Set(have ? have.b.flatMap((x) => x.p.map((p) => p[0])) : [])
  return {
    manifest,
    uploads: [...uploads].filter(([name]) => !haveNames.has(name)).map(([name, data]) => ({ name, data })),
    refs
  }
}

export function sameManifest(a: Manifest | null | undefined, b: Manifest | null | undefined): boolean {
  if (!a || !b) return false
  return a.n === b.n && (a.gc ?? '') === (b.gc ?? '') && a.b.length === b.b.length && a.b.every((x, i) => x.h === b.b[i].h)
}

export function isManifest(x: unknown): x is Manifest {
  if (!x || typeof x !== 'object') return false
  const m = x as Manifest
  if (m.v !== 2 || !Number.isInteger(m.n) || m.n < 1 || (m.n & (m.n - 1)) !== 0 || !Array.isArray(m.b) || m.b.length !== m.n) return false
  return m.b.every((r) => r && typeof r.h === 'string' && Array.isArray(r.p) && r.p.every((p) => Array.isArray(p) && typeof p[0] === 'string'))
}

/**
 * Build the doc a manifest describes. Buckets that match `base` (the doc and
 * manifest from this device's last sync) come from it; only the rest are fetched.
 */
export async function assembleDoc(
  keys: VaultKeys,
  manifest: Manifest,
  base: { doc: Doc; manifest: Manifest } | null,
  fetchChunks: (names: string[]) => Promise<Map<string, Uint8Array>>
): Promise<{ doc: Doc; fetched: number }> {
  const reuse = base && base.manifest.n === manifest.n ? splitDoc(base.doc, manifest.n) : null
  const need = new Set<number>()
  manifest.b.forEach((r, i) => {
    if (!r.h) return
    if (reuse && base!.manifest.b[i]?.h === r.h) return
    need.add(i)
  })
  // Pieces of a changed bucket that did not change (often the start of it) can be
  // rebuilt from the local copy of that bucket instead of downloaded again.
  const local = new Map<string, Uint8Array>()
  if (reuse) {
    for (const i of need) {
      const old = base!.manifest.b[i]
      if (!old?.h) continue
      const wanted = new Set(manifest.b[i].p.map((p) => p[0]))
      if (!old.p.some((p) => wanted.has(p[0]))) continue
      const gz = gzip(strToU8(stableStringify(reuse[i])))
      for (let o = 0; o < gz.length; o += PART_BYTES) {
        const piece = gz.slice(o, o + PART_BYTES)
        const name = chunkName(keys, piece)
        if (wanted.has(name)) local.set(name, piece)
      }
    }
  }
  const names = [...new Set([...need].flatMap((i) => manifest.b[i].p.map((p) => p[0])))].filter((n) => !local.has(n))
  const got = names.length ? await fetchChunks(names) : new Map<string, Uint8Array>()
  const c: Doc['c'] = {}
  const add = (bucket: Bucket): void => {
    for (const [coll, items] of Object.entries(bucket)) Object.assign((c[coll] ??= {}), items)
  }
  manifest.b.forEach((r, i) => {
    if (!r.h) return
    if (!need.has(i)) return add(reuse![i])
    const pieces = r.p.map(([name]) => {
      const plain = local.get(name)
      if (plain) return plain
      const data = got.get(name)
      if (!data) throw new Error('Sync data on the server is incomplete. Try again.')
      return decryptBytes(keys, data, AAD.chunk(keys.vaultId, name))
    })
    const gz = new Uint8Array(pieces.reduce((s, x) => s + x.length, 0))
    let o = 0
    for (const x of pieces) {
      gz.set(x, o)
      o += x.length
    }
    const json = strFromU8(gunzip(gz))
    if (chunkName(keys, json) !== r.h) throw new Error('Sync data on the server does not match its list')
    add(JSON.parse(json) as Bucket)
  })
  const doc: Doc = { v: 1, c }
  if (manifest.gc) doc.gc = manifest.gc
  return { doc, fetched: names.length }
}
