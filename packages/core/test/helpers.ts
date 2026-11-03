import { deriveKeys, generateSyncKey, newDeviceId } from '../src/crypto'
import type { Schema, Snapshot } from '../src/doc'
import { recordLocalEdits, syncOnce, type SyncState } from '../src/engine'
import type { PutResult, Transport } from '../src/transport'

export const schema: Schema = {
  collections: ['settings', 'logs', 'labs'],
  textFields: { logs: ['body'], labs: ['writeup'] },
  titleField: { logs: 'title', labs: 'name' },
  localFields: { settings: ['theme'] }
}

/** In-memory stand-in for the Worker: one blob and a version number. */
export class MemoryServer {
  body: Uint8Array | null = null
  version = 0
  puts = 0
  /** Runs once before the next PUT is checked (to fake another device writing). */
  beforePut: (() => Promise<void>) | null = null

  transport(): Transport {
    return {
      get: async () => (this.body ? { version: this.version, body: this.body } : null),
      put: async (body, ifMatch): Promise<PutResult> => {
        const hook = this.beforePut
        this.beforePut = null
        if (hook) await hook()
        const current = this.body ? this.version : null
        if (current !== ifMatch) return { ok: false, version: current }
        this.body = body
        this.version += 1
        this.puts++
        return { ok: true, version: this.version }
      },
      remove: async () => {
        this.body = null
      }
    }
  }
}

export class Device {
  data: Snapshot
  state: SyncState
  constructor(
    readonly server: MemoryServer,
    readonly keys = deriveKeys(generateSyncKey()),
    data: Snapshot = { settings: [{ id: 'settings', theme: 'dark', name: '', weeklyGoalHours: 8 }], logs: [], labs: [] },
    public now: () => number = () => Date.now()
  ) {
    this.data = JSON.parse(JSON.stringify(data)) as Snapshot
    this.state = { device: newDeviceId(), vaultId: keys.vaultId, base: null, version: null }
  }
  sync(onJoin?: (s: Snapshot) => Snapshot, duringPut?: () => void) {
    return syncOnce({
      schema,
      keys: this.keys,
      transport: this.server.transport(),
      state: this.state,
      saveState: (s) => {
        this.state = JSON.parse(JSON.stringify(s)) as SyncState
      },
      read: () => {
        const snap = JSON.parse(JSON.stringify(this.data)) as Snapshot
        return snap
      },
      write: (s) => {
        this.data = s
      },
      onJoin,
      now: this.now,
      ...(duringPut ? {} : {})
    })
  }
  /** Stamp edits now, offline (what the apps do after each save). */
  record() {
    return recordLocalEdits({
      schema,
      state: this.state,
      saveState: (s) => {
        this.state = JSON.parse(JSON.stringify(s)) as SyncState
      },
      read: () => JSON.parse(JSON.stringify(this.data)) as Snapshot,
      now: this.now
    })
  }
  log(id: string) {
    return this.data.logs.find((l) => l.id === id)
  }
  setLog(id: string, patch: Record<string, unknown>) {
    const i = this.data.logs.findIndex((l) => l.id === id)
    if (i < 0) this.data.logs.unshift({ id, title: '', body: '', tags: [], ...patch })
    else this.data.logs[i] = { ...this.data.logs[i], ...patch }
  }
  removeLog(id: string) {
    this.data.logs = this.data.logs.filter((l) => l.id !== id)
  }
}

/** Two devices paired to one server, both synced once. */
export async function pair(now?: () => number) {
  const server = new MemoryServer()
  const a = new Device(server, undefined, undefined, now)
  const b = new Device(server, a.keys, undefined, now)
  a.setLog('l1', { title: 'SQL injection', body: 'line 1\nline 2\nline 3\nline 4\nline 5' })
  await a.sync()
  await b.sync()
  return { server, a, b }
}
