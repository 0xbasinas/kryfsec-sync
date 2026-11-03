import { describe, expect, it } from 'vitest'
import { TestServer } from './server'
import { SyncController, timeAgo, type SyncStorage } from '../src/controller'
import type { SyncState } from '../src/engine'
import { appToSnapshot, dropSamples, KRYFSEC_SCHEMA, snapshotToApp, type KryfsecData } from '../src/kryfsec'

/** A fake server that speaks the real HTTP API. */
function fakeServer() {
  const server = new TestServer()
  return Object.assign(server, { setOnline: (x: boolean) => (server.online = x) })
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
    expect(server.size).toBe(0)
    expect(again.status.paired).toBe(false)
    expect(a.storage.key).toBeNull()
  })

  it('syncs adds, edits and deletes in every collection, both ways', async () => {
    const server = fakeServer()
    const desk = app(server, 'a')
    const phone = app(server, 'b')
    const empty = (d: KryfsecData): KryfsecData => ({ ...d, areas: [], topics: [], logs: [] })
    desk.edit(empty)
    phone.edit(empty)
    await phone.ctl.join(await desk.ctl.create())

    // Made on the phone.
    phone.edit((d) => ({
      ...d,
      areas: [{ id: 'ar', name: 'Forensics', icon: 'shield', color: 'var(--c-sage)', description: 'Disks' }],
      topics: [
        { id: 'tp', areaId: 'ar', title: 'Volatility', status: 'todo', notes: '' },
        { id: 'tp2', areaId: 'ar', title: 'Autopsy', status: 'todo', notes: '' }
      ],
      labs: [{ id: 'lb', name: 'Lame', platform: 'Hack The Box', difficulty: 'easy', status: 'todo', url: '', writeup: '', tags: [], minutes: 0 }],
      resources: [{ id: 'rs', title: 'CyberChef', kind: 'tool', url: 'https://gchq.github.io/CyberChef/', status: 'todo', notes: '', free: true }],
      certs: [{ id: 'ct', name: 'eJPT', provider: 'INE', progress: 0, status: 'planned', notes: '', url: '' }],
      goals: [{ id: 'gl', title: 'Root 3 boxes', done: false }]
    }))
    await phone.ctl.syncNow()
    await desk.ctl.syncNow()
    for (const k of ['areas', 'topics', 'labs', 'resources', 'certs', 'goals'] as const) expect(desk.data[k].length, k).toBeGreaterThan(0)

    // Edited on the desktop, while the phone changes other fields of the same items.
    desk.edit((d) => ({
      ...d,
      areas: d.areas.map((x) => ({ ...x, name: 'DFIR' })),
      topics: d.topics.map((x) => (x.id === 'tp' ? { ...x, notes: 'pslist, netscan' } : x)),
      labs: d.labs.map((x) => ({ ...x, name: 'Lame (retired)' })),
      resources: d.resources.map((x) => ({ ...x, status: 'done' })),
      certs: d.certs.map((x) => ({ ...x, progress: 40 })),
      goals: []
    }))
    phone.edit((d) => ({
      ...d,
      topics: d.topics.map((x) => (x.id === 'tp' ? { ...x, status: 'learning' } : x)),
      labs: d.labs.map((x) => ({ ...x, status: 'done' })),
      certs: d.certs.map((x) => ({ ...x, status: 'studying' }))
    }))
    await desk.ctl.syncNow()
    await phone.ctl.syncNow()
    await desk.ctl.syncNow()
    for (const d of [desk.data, phone.data]) {
      expect(d.areas[0]).toMatchObject({ name: 'DFIR' })
      expect(d.topics.find((x) => x.id === 'tp')).toMatchObject({ notes: 'pslist, netscan', status: 'learning' })
      expect(d.labs[0]).toMatchObject({ name: 'Lame (retired)', status: 'done' })
      expect(d.resources[0]).toMatchObject({ status: 'done' })
      expect(d.certs[0]).toMatchObject({ progress: 40, status: 'studying' })
      expect(d.goals).toEqual([])
    }

    // Deleting an area (and its topics) on the phone sticks on the desktop.
    phone.edit((d) => ({ ...d, areas: [], topics: [] }))
    await phone.ctl.syncNow()
    await desk.ctl.syncNow()
    expect(desk.data.areas).toEqual([])
    expect(desk.data.topics).toEqual([])
    desk.ctl.dispose()
    phone.ctl.dispose()
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
