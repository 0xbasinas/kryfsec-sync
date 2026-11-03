import { describe, expect, it } from 'vitest'
import { emptyDoc, merge, stamp, toSnapshot, docsEqual, collectGarbage, TOMBSTONE_TTL_MS, CONFLICT_SUFFIX } from '../src/doc'
import { Clock, formatHlc, parseHlc, bumpHlc } from '../src/hlc'
import { mergeText } from '../src/text'
import { Device, MemoryServer, pair, schema } from './helpers'

describe('hybrid logical clock', () => {
  it('never goes backwards when the computer clock does', () => {
    let t = 1_000_000
    const c = new Clock('dev', undefined, () => t)
    const a = c.tick()
    t -= 60_000
    const b = c.tick()
    expect(b > a).toBe(true)
  })
  it('jumps forward after seeing a newer stamp', () => {
    const c = new Clock('aaa', undefined, () => 1000)
    c.observe(formatHlc({ wall: 5000, counter: 3, device: 'bbb' }))
    const t = parseHlc(c.tick())
    expect(t.wall).toBe(5000)
    expect(t.counter).toBe(4)
  })
  it('ignores stamps far in the future', () => {
    const c = new Clock('aaa', undefined, () => 1000)
    c.observe(formatHlc({ wall: 1000 + 10 * 24 * 3600 * 1000, counter: 0, device: 'bad' }))
    expect(parseHlc(c.tick()).wall).toBe(1000)
  })
  it('bump is just after the stamp', () => {
    const h = formatHlc({ wall: 10, counter: 2, device: 'x' })
    expect(bumpHlc(h) > h).toBe(true)
  })
})

describe('three-way text merge', () => {
  it('keeps edits to different lines', () => {
    const r = mergeText('a\nb\nc\nd', 'A\nb\nc\nd', 'a\nb\nc\nD')
    expect(r).toEqual({ conflict: false, text: 'A\nb\nc\nD' })
  })
  it('reports edits to the same line', () => {
    expect(mergeText('a\nb', 'x\nb', 'y\nb').conflict).toBe(true)
  })
  it('same edit on both sides is not a conflict', () => {
    expect(mergeText('a\nb', 'z\nb', 'z\nb')).toEqual({ conflict: false, text: 'z\nb' })
  })
})

describe('sync between two devices', () => {
  it('pairing copies data to the new device', async () => {
    const { a, b } = await pair()
    expect(b.log('l1')?.title).toBe('SQL injection')
    expect(b.data.logs).toEqual(a.data.logs)
  })

  it('keeps edits to different fields of one item', async () => {
    const { a, b } = await pair()
    a.setLog('l1', { title: 'SQLi: UNION' })
    b.setLog('l1', { tags: ['web'] })
    await a.sync()
    await b.sync()
    await a.sync()
    expect(a.log('l1')).toMatchObject({ title: 'SQLi: UNION', tags: ['web'] })
    expect(b.data).toEqual(a.data)
  })

  it('offline edits keep the time they were made', async () => {
    const { a, b } = await pair()
    a.setLog('l1', { title: 'A, made first (offline)' })
    await a.record()
    await new Promise((r) => setTimeout(r, 2))
    b.setLog('l1', { title: 'B, made later' })
    await b.record()
    // a comes online last, but its edit is older, so B's title stays
    await b.sync()
    await a.sync()
    await b.sync()
    expect(a.log('l1')?.title).toBe('B, made later')
    expect(b.log('l1')?.title).toBe('B, made later')
  })

  it('same field: the later change wins', async () => {
    const { a, b } = await pair()
    a.setLog('l1', { title: 'from A' })
    await new Promise((r) => setTimeout(r, 2))
    // b changes later, but syncs first
    b.setLog('l1', { title: 'from B' })
    // stamps are made when sync runs, so sync a first to give it the older stamp
    await a.sync()
    await b.sync()
    await a.sync()
    expect(a.log('l1')?.title).toBe('from B')
    expect(b.log('l1')?.title).toBe('from B')
  })

  it('merges note text edited on both devices (different lines)', async () => {
    const { a, b } = await pair()
    a.setLog('l1', { body: 'line 1 (A)\nline 2\nline 3\nline 4\nline 5' })
    b.setLog('l1', { body: 'line 1\nline 2\nline 3\nline 4\nline 5 (B)' })
    await a.sync()
    const r = await b.sync()
    await a.sync()
    expect(r.conflicts).toBe(0)
    expect(b.log('l1')?.body).toBe('line 1 (A)\nline 2\nline 3\nline 4\nline 5 (B)')
    expect(a.data).toEqual(b.data)
    expect(a.data.logs).toHaveLength(1)
  })

  it('same line edited on both devices: nothing is lost, a conflict copy is made', async () => {
    const { a, b } = await pair()
    a.setLog('l1', { body: 'line 1 A' })
    b.setLog('l1', { body: 'line 1 B' })
    await a.sync()
    const r = await b.sync()
    await a.sync()
    expect(r.conflicts).toBe(1)
    const bodies = a.data.logs.map((l) => l.body).sort()
    expect(bodies).toEqual(['line 1 A', 'line 1 B'])
    expect(a.data.logs.some((l) => String(l.title).endsWith(CONFLICT_SUFFIX))).toBe(true)
    const byId = (d: Device) => [...d.data.logs].sort((x, y) => x.id.localeCompare(y.id))
    expect(byId(a)).toEqual(byId(b))
    // more syncs do not make more copies
    await b.sync()
    await a.sync()
    expect(a.data.logs).toHaveLength(2)
  })

  it('delete on one device, older edit on the other: the delete wins', async () => {
    const { a, b } = await pair()
    b.setLog('l1', { title: 'edited' })
    await b.sync() // edit is stamped first
    a.removeLog('l1')
    await a.sync()
    await b.sync()
    expect(a.log('l1')).toBeUndefined()
    expect(b.log('l1')).toBeUndefined()
  })

  it('edit made after a delete brings the item back', async () => {
    const { a, b } = await pair()
    a.removeLog('l1')
    await a.sync()
    b.setLog('l1', { title: 'still working on this' })
    await b.sync() // b pulls the delete, but its edit is newer
    await a.sync()
    expect(b.log('l1')?.title).toBe('still working on this')
    expect(a.log('l1')?.title).toBe('still working on this')
  })

  it('a device with a slow clock still wins when it edits later', async () => {
    let skew = -3 * 60 * 60 * 1000 // b is 3 hours behind
    const server = new MemoryServer()
    const a = new Device(server)
    const b = new Device(server, a.keys, undefined, () => Date.now() + skew)
    a.setLog('l1', { title: 'v1' })
    await a.sync()
    await b.sync()
    a.setLog('l1', { title: 'from A' })
    await a.sync()
    await b.sync() // b sees A's stamp and moves its clock forward
    b.setLog('l1', { title: 'from B, later' })
    await b.sync()
    await a.sync()
    expect(a.log('l1')?.title).toBe('from B, later')
    skew = 0
  })

  it('sync with no changes does not upload again', async () => {
    const { a, b, server } = await pair()
    const before = server.puts
    await a.sync()
    await b.sync()
    await a.sync()
    expect(server.puts).toBe(before)
  })

  it('retries after a version clash (409) and keeps both edits', async () => {
    const { a, b, server } = await pair()
    a.setLog('l1', { title: 'A title' })
    b.setLog('l1', { tags: ['b-tag'] })
    server.beforePut = async () => {
      await b.sync() // b writes between a's GET and PUT
    }
    await a.sync()
    await b.sync()
    expect(a.log('l1')).toMatchObject({ title: 'A title', tags: ['b-tag'] })
    expect(b.data).toEqual(a.data)
  })

  it('local settings like theme are not synced', async () => {
    const { a, b } = await pair()
    a.data.settings[0] = { ...a.data.settings[0], theme: 'light', name: 'George' }
    await a.sync()
    await b.sync()
    expect(b.data.settings[0]).toMatchObject({ name: 'George' })
    expect(b.data.settings[0].theme).toBeUndefined()
  })

  it('joining device drops its own sample data', async () => {
    const server = new MemoryServer()
    const a = new Device(server)
    a.setLog('real', { title: 'my note' })
    await a.sync()
    const b = new Device(server, a.keys)
    b.setLog('sample1', { title: 'sample', sample: true })
    b.setLog('mine', { title: 'made on phone' })
    await b.sync((s) => ({ ...s, logs: s.logs.filter((l) => !l.sample) }))
    await a.sync()
    expect(b.data.logs.map((l) => l.id).sort()).toEqual(['mine', 'real'])
    expect(a.data.logs.map((l) => l.id).sort()).toEqual(['mine', 'real'])
  })

  it('clearing an optional field syncs', async () => {
    const { a, b } = await pair()
    a.setLog('l1', { topicId: 't1' })
    await a.sync()
    await b.sync()
    expect(b.log('l1')?.topicId).toBe('t1')
    a.setLog('l1', { topicId: undefined })
    await a.sync()
    await b.sync()
    expect(b.log('l1')?.topicId).toBeUndefined()
  })
})

describe('doc merge', () => {
  it('is idempotent and order does not matter', () => {
    const ca = new Clock('aaa')
    const cb = new Clock('bbb')
    const base = stamp(null, { logs: [{ id: 'x', title: 't', body: 'a\nb\nc' }] }, ca, schema)
    const da = stamp(base, { logs: [{ id: 'x', title: 'T', body: 'A\nb\nc' }] }, ca, schema)
    const db = stamp(base, { logs: [{ id: 'x', title: 't', body: 'a\nb\nC' }, { id: 'y', title: 'new' }] }, cb, schema)
    const m1 = merge(da, db, base, schema).doc
    const m2 = merge(db, da, base, schema).doc
    expect(docsEqual(m1, m2)).toBe(true)
    expect(docsEqual(merge(m1, m1, base, schema).doc, m1)).toBe(true)
    expect(docsEqual(merge(m1, da, base, schema).doc, m1)).toBe(true)
    expect(docsEqual(merge(m1, db, base, schema).doc, m1)).toBe(true)
    expect(toSnapshot(m1, schema).logs.find((l) => l.id === 'x')).toMatchObject({ title: 'T', body: 'A\nb\nC' })
  })

  it('removes old tombstones and does not bring them back', () => {
    const t0 = 1_700_000_000_000
    const c = new Clock('aaa', undefined, () => t0)
    const d1 = stamp(null, { logs: [{ id: 'x', title: 't' }] }, c, schema)
    const d2 = stamp(d1, { logs: [] }, c, schema)
    const later = t0 + TOMBSTONE_TTL_MS + 1000
    const cleaned = collectGarbage(JSON.parse(JSON.stringify(d2)), later)
    expect(cleaned.c.logs.x).toBeUndefined()
    expect(cleaned.gc).toBeDefined()
    // an old device that still has the tombstone in its base merges cleanly
    const merged = merge(d2, cleaned, d2, schema, later).doc
    expect(merged.c.logs.x).toBeUndefined()
    expect(toSnapshot(merged, schema).logs).toEqual([])
  })

  it('empty docs merge to empty', () => {
    expect(merge(emptyDoc(), emptyDoc(), null, schema).doc).toEqual({ v: 1, c: {} })
  })
})
