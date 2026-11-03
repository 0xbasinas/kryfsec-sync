// Runs only with SYNC_URL set, e.g. SYNC_URL=http://127.0.0.1:8787 npx vitest run live
// Two devices sync real encrypted data through a running server, then the vault is deleted.
import { describe, expect, it } from 'vitest'
import { deriveKeys, generateSyncKey, newDeviceId } from '../src/crypto'
import type { Snapshot } from '../src/doc'
import { deleteVault, syncOnce, type SyncState } from '../src/engine'
import { fetchHttp, httpTransport } from '../src/transport'
import { schema } from './helpers'

declare const process: { env: Record<string, string | undefined> }
const url = process.env.SYNC_URL

describe.skipIf(!url)('live server', () => {
  it('two devices sync through the real server', async () => {
    const keys = deriveKeys(generateSyncKey())
    const transport = httpTransport({ baseUrl: url, keys, http: fetchHttp() })
    const make = (logs: Snapshot[string]) => {
      const dev = {
        data: { settings: [{ id: 'settings', theme: 'dark' }], logs, labs: [] } as Snapshot,
        state: { device: newDeviceId(), vaultId: keys.vaultId, base: null, version: null } as SyncState
      }
      const sync = () =>
        syncOnce({
          schema,
          keys,
          transport,
          state: dev.state,
          saveState: () => {},
          read: () => JSON.parse(JSON.stringify(dev.data)) as Snapshot,
          write: (s) => (dev.data = s)
        })
      return { dev, sync }
    }
    try {
      const a = make([{ id: 'l1', title: 'from A', body: 'line 1\nline 2\nline 3' }])
      const b = make([{ id: 'l2', title: 'from B', body: '' }])
      await a.sync()
      await b.sync()
      await a.sync()
      expect(a.dev.data.logs.map((l) => l.id).sort()).toEqual(['l1', 'l2'])
      expect(b.dev.data.logs.map((l) => l.id).sort()).toEqual(['l1', 'l2'])
      // Edit different lines of the same note on both, then sync.
      a.dev.data.logs = a.dev.data.logs.map((l) => (l.id === 'l1' ? { ...l, body: 'line 1 (A)\nline 2\nline 3' } : l))
      b.dev.data.logs = b.dev.data.logs.map((l) => (l.id === 'l1' ? { ...l, body: 'line 1\nline 2\nline 3 (B)' } : l))
      await a.sync()
      await b.sync()
      await a.sync()
      const body = (d: Snapshot) => d.logs.find((l) => l.id === 'l1')?.body
      expect(body(a.dev.data)).toBe('line 1 (A)\nline 2\nline 3 (B)')
      expect(body(b.dev.data)).toBe(body(a.dev.data))
    } finally {
      await deleteVault(transport)
    }
    expect(await transport.get()).toBeNull()
  })

  it('a vault over 4 MB syncs in pieces, and a small edit uploads one piece', { timeout: 300_000 }, async () => {
    const keys = deriveKeys(generateSyncKey())
    const transport = httpTransport({ baseUrl: url, keys, http: fetchHttp() })
    let x = 7
    const noise = (len: number): string => {
      let s = ''
      while (s.length < len) {
        x ^= x << 13
        x ^= x >>> 17
        x ^= x << 5
        s += (x >>> 0).toString(36)
      }
      return s.slice(0, len)
    }
    const count = Number(process.env.LIVE_LOGS ?? 5000)
    const logs = Array.from({ length: count }, (_, i) => ({ id: `log-${i}`, title: `note ${i}`, body: noise(1500) }))
    const make = (l: Snapshot[string]) => {
      const dev = {
        data: { settings: [{ id: 'settings', theme: 'dark' }], logs: l, labs: [] } as Snapshot,
        state: { device: newDeviceId(), vaultId: keys.vaultId, base: null, version: null } as SyncState
      }
      const sync = () =>
        syncOnce({
          schema,
          keys,
          transport,
          state: dev.state,
          saveState: () => {},
          read: () => JSON.parse(JSON.stringify(dev.data)) as Snapshot,
          write: (s) => (dev.data = s)
        })
      return { dev, sync }
    }
    try {
      const a = make(logs)
      const t0 = Date.now()
      const first = await a.sync()
      const stored = a.dev.state.manifest!.b.reduce((s, b) => s + b.p.reduce((t, p) => t + p[1], 0), 0)
      console.log(`first upload: ${first.uploaded} pieces, ${(stored / 1048576).toFixed(1)} MB stored, ${Date.now() - t0} ms`)
      expect(stored).toBeGreaterThan(4 * 1024 * 1024)

      const b = make([])
      const t1 = Date.now()
      const join = await b.sync()
      console.log(`second device: ${join.fetched} pieces downloaded, ${Date.now() - t1} ms`)
      expect(b.dev.data.logs.length).toBe(count)
      await a.sync()

      b.dev.data.logs = b.dev.data.logs.map((l) => (l.id === 'log-1234' ? { ...l, title: 'small edit' } : l))
      const t2 = Date.now()
      const edit = await b.sync()
      console.log(`small edit: ${edit.uploaded} piece uploaded, ${Date.now() - t2} ms`)
      expect(edit.uploaded).toBe(1)
      const pull = await a.sync()
      console.log(`other device: ${pull.fetched} piece downloaded`)
      expect(pull.fetched).toBe(1)
      expect(a.dev.data.logs.find((l) => l.id === 'log-1234')?.title).toBe('small edit')
    } finally {
      await deleteVault(transport)
    }
    expect(await transport.get()).toBeNull()
  })
})
