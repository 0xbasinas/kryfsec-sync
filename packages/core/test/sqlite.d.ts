// Just what the tests use of Node's built-in SQLite (Node 22.5+).
declare module 'node:sqlite' {
  export class DatabaseSync {
    constructor(path: string)
    exec(sql: string): void
    prepare(sql: string): { all(...params: unknown[]): Record<string, unknown>[] }
    close(): void
  }
}
