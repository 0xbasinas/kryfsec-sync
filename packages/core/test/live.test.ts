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
})
