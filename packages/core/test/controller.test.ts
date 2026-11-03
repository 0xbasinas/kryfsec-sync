import { describe, expect, it } from 'vitest'
import { SyncController, timeAgo, type SyncStorage } from '../src/controller'
import type { SyncState } from '../src/engine'
import { appToSnapshot, dropSamples, KRYFSEC_SCHEMA, snapshotToApp, type KryfsecData } from '../src/kryfsec'
import type { HttpFn } from '../src/transport'

/** A fake server that speaks the real HTTP API. */
function fakeServer() {
  const vaults = new Map<string, { body: Uint8Array; version: number; auth: string }>()
  let online = true
  const http: HttpFn = async (req) => {
    if (!online) throw new (await import('../src/transport')).SyncNetworkError()
    const id = req.url.split('/').pop()!
    const auth = req.headers.authorization
    const v = vaults.get(id)
    const etag = (n: number) => ({ etag: `"${n}"` })
    const empty = new Uint8Array()
    if (v && v.auth !== auth) return { status: 401, headers: {}, body: empty }
    if (req.method === 'GET') return v ? { status: 200, headers: etag(v.version), body: v.body } : { status: 404, headers: {}, body: empty }
    if (req.method === 'DELETE') {
      vaults.delete(id)
      return { status: 204, headers: {}, body: empty }
    }
    const create = req.headers['if-none-match'] === '*'
    const match = req.headers['if-match'] ? Number(req.headers['if-match'].replace(/"/g, '')) : null
    if (!v && !create) return { status: 409, headers: {}, body: empty }
    if (v && (create || match !== v.version)) return { status: 409, headers: etag(v.version), body: empty }
    const version = (v?.version ?? 0) + 1
    vaults.set(id, { body: req.body!, version, auth: auth! })
    return { status: v ? 200 : 201, headers: etag(version), body: empty }
  }
  return { http, vaults, setOnline: (x: boolean) => (online = x) }
}

function memoryStorage(): SyncStorage & { key: string | null; state: SyncState | null } {
  return {
    key: null,
    state: null,
    async loadKey() {
      return this.key
    },
    async saveKey(k) {
      this.key = k
    },
    async loadState() {
      return this.state ? (JSON.parse(JSON.stringify(this.state)) as SyncState) : null
    },
    async saveState(s) {
      this.state = s ? (JSON.parse(JSON.stringify(s)) as SyncState) : null
    }
  }
}

const sample = (who: string): KryfsecData => ({
  settings: { theme: who === 'a' ? 'dark' : 'light', name: who, weeklyGoalHours: 8, accent: 'periwinkle' },
  areas: [{ id: `${who}-area`, name: 'Web', description: '', sample: true }],
  topics: [{ id: `${who}-topic`, areaId: `${who}-area`, title: 'SQLi', status: 'todo', notes: '', sample: true }],
  logs: [{ id: `${who}-sample-log`, title: 'Example', body: 'hi', sample: true }],
  resources: [],
  labs: [],
  certs: [],
  goals: []
})

function app(server: ReturnType<typeof fakeServer>, who: string) {
  let data = sample(who)
  const storage = memoryStorage()
  const ctl = new SyncController({
    http: server.http,
    storage,
    schema: KRYFSEC_SCHEMA,
    read: () => appToSnapshot(data),
    write: (s) => (data = snapshotToApp(s, data)),
    onJoin: dropSamples,
    editDelayMs: 1,
    retryMs: 60_000
  })
  return {
    ctl,
    storage,
    get data() {
      return data
    },
    edit(fn: (d: KryfsecData) => KryfsecData) {
      data = fn(data)
      ctl.noteEdit()
    }
  }
}

describe('SyncController with kryfsec data', () => {
  it('pairs two fresh installs without doubling the starter data', async () => {
    const server = fakeServer()
    const a = app(server, 'a')
    const b = app(server, 'b')
    await a.ctl.init()
    await b.ctl.init()
    b.edit((d) => ({ ...d, logs: [{ id: 'b-mine', title: 'My own entry', body: 'x' }, ...d.logs] }))
    const key = await a.ctl.create()
    expect(key).toMatch(/^KS1-/)
    await b.ctl.join(key)
    await a.ctl.syncNow()
    const ids = (d: KryfsecData) => d.logs.map((l) => l.id).sort()
    expect(ids(a.data)).toEqual(['a-sample-log', 'b-mine'])
    expect(ids(b.data)).toEqual(['a-sample-log', 'b-mine'])
    expect(b.data.areas.map((x) => x.id)).toEqual(['a-area'])
    // Theme stays on each device; the name syncs.
    expect(a.data.settings.theme).toBe('dark')
    expect(b.data.settings.theme).toBe('light')
    expect(b.data.settings.name).toBe('a')
    expect(a.ctl.status.paired && b.ctl.status.paired).toBe(true)
    expect(timeAgo(a.ctl.status.lastSync)).toBe('just now')
  })

  it('keeps working offline and catches up later', async () => {
    const server = fakeServer()
    const a = app(server, 'a')
    const b = app(server, 'b')
    const key = await a.ctl.create()
    await b.ctl.join(key)
    server.setOnline(false)
    a.edit((d) => ({ ...d, logs: d.logs.map((l) => (l.id === 'a-sample-log' ? { ...l, title: 'Edited offline' } : l)) }))
    await a.ctl.syncNow()
    expect(a.ctl.status.offline).toBe(true)
    expect(a.ctl.status.error).toBeUndefined()
    server.setOnline(true)
    await a.ctl.syncNow()
    await b.ctl.syncNow()
    expect(a.ctl.status.offline).toBe(false)
    expect(b.data.logs.find((l) => l.id === 'a-sample-log')?.title).toBe('Edited offline')
    a.ctl.dispose()
    b.ctl.dispose()
  })

  it('restores after a restart and rejects a bad key', async () => {
    const server = fakeServer()
    const a = app(server, 'a')
    await a.ctl.create()
    const again = new SyncController({
      http: server.http,
      storage: a.storage,
      schema: KRYFSEC_SCHEMA,
      read: () => appToSnapshot(a.data),
      write: () => {}
    })
    const st = await again.init()
    expect(st.paired).toBe(true)
    expect(again.keyText()).toBe(a.ctl.keyText())
    await expect(again.join('KS1-nope')).rejects.toThrow(/not valid/)
    await again.unpair({ deleteServerCopy: true })
    expect(server.vaults.size).toBe(0)
    expect(again.status.paired).toBe(false)
    expect(a.storage.key).toBeNull()
  })

  it('keeps the local order and puts new items first', () => {
    const cur = sample('a')
    cur.logs = [
      { id: '1', title: 'one' },
      { id: '2', title: 'two' }
    ]
    const snap = appToSnapshot(cur)
    snap.logs = [{ id: '2', title: 'two!' }, { id: '3', title: 'new' }, { id: '1', title: 'one' }]
    expect(snapshotToApp(snap, cur).logs.map((l) => l.id)).toEqual(['3', '1', '2'])
  })
})
