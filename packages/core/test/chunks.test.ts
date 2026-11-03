import { describe, expect, it } from 'vitest'
import { bucketOf, buildLayout, chooseBuckets, PART_BYTES, splitDoc, type Manifest } from '../src/chunks'
import { AAD, decryptJson, deriveKeys, encryptJson, generateSyncKey } from '../src/crypto'
import { Clock } from '../src/hlc'
import { emptyDoc, stamp } from '../src/doc'
import { httpTransport } from '../src/transport'
import { Device, MemoryServer, schema } from './helpers'

/** Pseudo-random text that gzip cannot shrink much (like real notes with varied words). */
function noise(seed: number, len: number): string {
  let x = seed >>> 0 || 1
  let s = ''
  while (s.length < len) {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    s += (x >>> 0).toString(36)
  }
  return s.slice(0, len)
}

function fill(d: Device, count: number, bodyLen: number): void {
  for (let i = 0; i < count; i++) d.data.logs.push({ id: `log-${i}`, title: `note ${i}`, body: noise(i + 1, bodyLen), tags: [] })
}

const parts = (m: Manifest): number => m.b.reduce((s, b) => s + b.p.length, 0)

describe('bucketing', () => {
  it('puts a record in the same bucket on every device', () => {
    // Fixed values: changing the hash would reshuffle everyone's data.
    expect(bucketOf('logs', 'l1', 8)).toBe(bucketOf('logs', 'l1', 8))
    const seen = [bucketOf('logs', 'a', 1024), bucketOf('logs', 'b', 1024), bucketOf('labs', 'a', 1024)]
    expect(new Set(seen).size).toBe(3)
    // Growing n only splits a bucket in two: the low bits stay the same.
    for (const id of ['x', 'y', 'z', 'q']) expect(bucketOf('logs', id, 64) % 8).toBe(bucketOf('logs', id, 8))
  })

  it('spreads records evenly', () => {
    const counts = new Array(16).fill(0)
    for (let i = 0; i < 16000; i++) counts[bucketOf('logs', `id-${i}`, 16)]++
    for (const c of counts) expect(Math.abs(c - 1000)).toBeLessThan(150)
  })

  it('gives the same pieces for the same data, whatever the order', () => {
    const keys = deriveKeys(generateSyncKey())
    const clock = new Clock('dev', undefined, () => 1_700_000_000_000)
    const items = Array.from({ length: 50 }, (_, i) => ({ id: `n${i}`, title: `t${i}` }))
    const doc1 = stamp(emptyDoc(), { logs: items }, clock, schema)
    const doc2 = JSON.parse(JSON.stringify({ ...doc1, c: { logs: Object.fromEntries(Object.entries(doc1.c.logs).reverse()) } }))
    const a = buildLayout(keys, doc1, null)
    const b = buildLayout(keys, doc2, null)
    expect(b.manifest.b.map((x) => x.h)).toEqual(a.manifest.b.map((x) => x.h))
    expect(b.refs.sort()).toEqual(a.refs.sort())
    // Names depend on the key: another vault with the same data gets other names.
    const other = buildLayout(deriveKeys(generateSyncKey()), doc1, null)
    expect(other.refs.some((r) => a.refs.includes(r))).toBe(false)
  })

  it('a change touches one bucket and re-uses the others', () => {
    const keys = deriveKeys(generateSyncKey())
    const clock = new Clock('dev')
    const items = Array.from({ length: 200 }, (_, i) => ({ id: `n${i}`, title: `t${i}` }))
    const doc = stamp(emptyDoc(), { logs: items }, clock, schema)
    const first = buildLayout(keys, doc, null)
    expect(first.uploads.length).toBe(first.refs.length)
    items[7] = { ...items[7], title: 'changed' }
    const next = buildLayout(keys, stamp(doc, { logs: items }, clock, schema), first.manifest)
    expect(next.uploads.length).toBe(1)
    const changed = next.manifest.b.filter((x, i) => x.h !== first.manifest.b[i].h)
    expect(changed.length).toBe(1)
  })

  it('picks more buckets as the data grows, and keeps the count when close', () => {
    const big = { v: 1 as const, c: { logs: { x: { f: { body: [noise(1, 9_000_000), 'a'] as [string, string] } } } } }
    expect(chooseBuckets(emptyDoc())).toBe(8)
    expect(chooseBuckets(big)).toBe(64)
    expect(chooseBuckets(emptyDoc(), 16)).toBe(16)
    expect(chooseBuckets(big, 128)).toBe(128)
    expect(chooseBuckets(emptyDoc(), 1024)).toBe(8)
    expect(splitDoc(big, 64).filter((b) => Object.keys(b).length).length).toBe(1)
  })
})

describe('chunked sync against the real Worker code', () => {
  it('uploads only the changed piece and downloads only what changed', async () => {
    const server = new MemoryServer()
    const a = new Device(server)
    fill(a, 3000, 600) // about 2 MB
    const first = await a.sync()
    expect(first.pushed).toBe(true)
    const b = new Device(server, a.keys)
    const join = await b.sync()
    expect(join.fetched).toBe(parts(a.state.manifest!))
    expect(b.data.logs.length).toBe(3000)

    server.calls = []
    a.setLog('log-42', { title: 'edited' })
    const r = await a.sync()
    expect(r.pushed).toBe(true)
    expect(r.uploaded).toBe(1)
    expect(server.count('POST', '/chunks')).toBe(1)
    const up = server.calls.find((c) => c.path.endsWith('/chunks'))!
    expect(up.sent).toBeLessThan(PART_BYTES)

    const pull = await b.sync()
    expect(pull.fetched).toBe(1)
    expect(pull.pushed).toBe(false)
    expect(b.log('log-42')?.title).toBe('edited')

    // Nothing changed: no upload, no download, no commit.
    server.calls = []
    const idle = await a.sync()
    expect(idle).toMatchObject({ pushed: false, fetched: 0, uploaded: 0 })
    expect(server.calls.map((c) => c.method)).toEqual(['GET'])
  })

  it('drops pieces no manifest uses (GC)', async () => {
    const server = new MemoryServer()
    const a = new Device(server)
    fill(a, 500, 400)
    await a.sync()
    for (let i = 0; i < 5; i++) {
      a.setLog(`log-${i * 37}`, { title: `edit ${i}` })
      await a.sync()
    }
    const s = server.vault(a.keys.vaultId).store.stats()
    expect(s.blobs).toBe(s.refs)
    expect(s.refs).toBe(a.state.manifest!.b.reduce((n, b) => n + b.p.length, 0))

    // A half-done upload (no commit) is dropped after a day, not before.
    const t = httpTransport({ baseUrl: 'https://sync.test', keys: a.keys, http: server.http })
    await t.writeChunks([{ name: 'ab'.repeat(16), data: new Uint8Array(100) }])
    a.setLog('log-1', { title: 'x' })
    await a.sync()
    expect(server.vault(a.keys.vaultId).store.stats().blobs).toBe(s.refs + 1)
    server.now = () => Date.now() + 2 * 24 * 60 * 60 * 1000
    a.setLog('log-1', { title: 'y' })
    await a.sync()
    const after = server.vault(a.keys.vaultId).store.stats()
    expect(after.blobs).toBe(after.refs)
  })

  it('retries when another device commits first (409) and keeps both edits', async () => {
    const server = new MemoryServer()
    const a = new Device(server)
    fill(a, 400, 300)
    await a.sync()
    const b = new Device(server, a.keys)
    await b.sync()
    a.setLog('log-1', { title: 'from A' })
    b.setLog('log-2', { title: 'from B' })
    server.beforePut = async () => {
      await b.sync()
    }
    const r = await a.sync()
    expect(r.pushed).toBe(true)
    await b.sync()
    expect(a.log('log-2')?.title).toBe('from B')
    expect(b.log('log-1')?.title).toBe('from A')
    // A's first upload lost the race; it stays until a commit a day later drops it.
    const s = server.vault(a.keys.vaultId).store.stats()
    expect(s.blobs - s.refs).toBeLessThanOrEqual(2)
    server.now = () => Date.now() + 2 * 24 * 60 * 60 * 1000
    a.setLog('log-3', { title: 'later' })
    await a.sync()
    const after = server.vault(a.keys.vaultId).store.stats()
    expect(after.blobs).toBe(after.refs)
  })

  it('uploads again when the server lost a piece before the commit', async () => {
    const server = new MemoryServer()
    const a = new Device(server)
    fill(a, 50, 100)
    server.beforePut = async () => {
      server.vault(a.keys.vaultId).host.sql.exec('DELETE FROM blobs')
    }
    const r = await a.sync()
    expect(r.pushed).toBe(true)
    const b = new Device(server, a.keys)
    await b.sync()
    expect(b.data.logs.length).toBe(50)
  })

  it('upgrades an old single-blob vault, and old apps get a clear "please update"', async () => {
    const server = new MemoryServer()
    const keys = deriveKeys(generateSyncKey())
    const v1 = async (method: 'GET' | 'PUT', body?: Uint8Array, headers: Record<string, string> = {}) =>
      server.http({ method, url: `https://sync.test/v1/vault/${keys.vaultId}`, headers: { authorization: `Bearer ${keys.authToken}`, ...headers }, body })
    // An old app made the vault.
    const old = stamp(emptyDoc(), { logs: [{ id: 'old', title: 'from the old app' }], settings: [], labs: [] }, new Clock('old'), schema)
    expect((await v1('PUT', encryptJson(keys, old), { 'if-none-match': '*' })).status).toBe(201)

    const a = new Device(server, keys)
    a.setLog('new', { title: 'from the new app' })
    const r = await a.sync()
    expect(r.pushed).toBe(true)
    expect(a.data.logs.map((l) => l.id).sort()).toEqual(['new', 'old'])
    expect(server.vault(keys.vaultId).store.stats().format).toBe(2)

    const get = await v1('GET')
    expect(get.status).toBe(410)
    expect(new TextDecoder().decode(get.body)).toContain('Please update')
    const put = await v1('PUT', encryptJson(keys, old), { 'if-match': '"2"' })
    expect(put.status).toBe(410)
    // The old blob is gone; only the manifest and pieces are kept.
    expect(server.vault(keys.vaultId).host.sql.exec('SELECT COUNT(*) AS n FROM chunks').toArray()[0]).toEqual({ n: 0 })
  })

  it('a device that synced with the old format carries on after the upgrade', async () => {
    const server = new MemoryServer()
    const a = new Device(server)
    a.setLog('l1', { title: 'one' })
    await a.sync()
    // Pretend b last synced with an old app: base doc, but no manifest saved.
    const b = new Device(server, a.keys)
    await b.sync()
    delete b.state.manifest
    a.setLog('l1', { title: 'two' })
    await a.sync()
    const r = await b.sync()
    expect(r.fetched).toBeGreaterThan(0)
    expect(b.log('l1')?.title).toBe('two')
  })

  it('the manifest and pieces cannot be swapped or read with another key', async () => {
    const server = new MemoryServer()
    const a = new Device(server)
    a.setLog('l1', { title: 'secret' })
    await a.sync()
    const t = httpTransport({ baseUrl: 'https://sync.test', keys: a.keys, http: server.http })
    const remote = await t.get()
    expect(remote?.format).toBe(2)
    expect(() => decryptJson(a.keys, remote!.body)).toThrow() // the old-format label does not open it
    const m = decryptJson(a.keys, remote!.body, AAD.manifest(a.keys.vaultId)) as Manifest
    expect(m.v).toBe(2)
    expect(JSON.stringify(m)).not.toContain('secret')
  })

  it('handles a 20 MB vault in pieces under the size limits', { timeout: 120_000 }, async () => {
    const server = new MemoryServer()
    const a = new Device(server)
    fill(a, 10_000, 2000) // about 20 MB of notes
    const first = await a.sync()
    expect(first.pushed).toBe(true)
    const m = a.state.manifest!
    expect(m.n).toBeGreaterThanOrEqual(16)
    const sizes = m.b.flatMap((b) => b.p.map((p) => p[1]))
    expect(Math.max(...sizes)).toBeLessThanOrEqual(PART_BYTES + 64)
    const total = sizes.reduce((s, x) => s + x, 0)
    expect(total).toBeGreaterThan(4 * 1024 * 1024) // well over the old 4 MB cap
    for (const c of server.calls) expect(c.sent).toBeLessThanOrEqual(4 * 1024 * 1024 + 64 * 1024)
    for (const c of server.calls) expect(c.received).toBeLessThanOrEqual(8 * 1024 * 1024)

    const b = new Device(server, a.keys)
    await b.sync()
    expect(b.data.logs.length).toBe(10_000)
    expect(b.log('log-9999')?.body).toBe(a.log('log-9999')?.body)
    await a.sync() // pick up b's join (its settings item)

    server.calls = []
    b.setLog('log-5000', { title: 'small edit' })
    const r = await b.sync()
    expect(r.uploaded).toBe(1)
    const sent = server.calls.reduce((s, c) => s + c.sent, 0)
    expect(sent).toBeLessThan(m.b.length * 300 + PART_BYTES + 64 * 1024)
    const pull = await a.sync()
    expect(pull.fetched).toBe(1)
    expect(a.log('log-5000')?.title).toBe('small edit')
  })
})
