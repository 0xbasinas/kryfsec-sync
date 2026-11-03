// Quick live check of a sync server. Usage: node scripts/smoke.mjs [baseUrl]
// Makes a random test vault, checks the API, then deletes the vault.
import { randomBytes } from 'node:crypto'

const base = (process.argv[2] || process.env.SYNC_URL || 'https://sync.kryfsec.com').replace(/\/$/, '')
const id = randomBytes(16).toString('hex')
const token = randomBytes(32).toString('base64url')
const other = randomBytes(32).toString('base64url')
const url = `${base}/v1/vault/${id}`
let failed = 0

function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed++
}
const auth = (t) => ({ authorization: `Bearer ${t}` })

const health = await fetch(`${base}/health`)
const hj = await health.json().catch(() => ({}))
check('GET /health', health.status === 200 && hj.ok === true, `${health.status}`)

let r = await fetch(url, { headers: auth(token) })
check('GET missing vault -> 404', r.status === 404, `${r.status}`)

r = await fetch(url, { method: 'PUT', headers: auth(token), body: 'x' })
check('PUT without If-Match -> 428', r.status === 428, `${r.status}`)

r = await fetch(url, { method: 'PUT', headers: { ...auth(token), 'if-none-match': '*' }, body: new Uint8Array([1, 2, 3]) })
check('PUT first (register) -> 201 v1', r.status === 201 && r.headers.get('etag') === '"1"', `${r.status} ${r.headers.get('etag')}`)

r = await fetch(url, { headers: auth(token) })
const got = new Uint8Array(await r.arrayBuffer())
check('GET -> same bytes, ETag "1"', r.status === 200 && r.headers.get('etag') === '"1"' && got.join() === '1,2,3', `${r.status}`)

r = await fetch(url, { method: 'PUT', headers: { ...auth(token), 'if-match': '"1"' }, body: new Uint8Array([4, 5]) })
check('PUT If-Match "1" -> 200 v2', r.status === 200 && r.headers.get('etag') === '"2"', `${r.status} ${r.headers.get('etag')}`)

r = await fetch(url, { method: 'PUT', headers: { ...auth(token), 'if-match': '"1"' }, body: new Uint8Array([6]) })
const cj = await r.json().catch(() => ({}))
check('PUT old version -> 409 with current version', r.status === 409 && cj.version === 2, `${r.status} v=${cj.version}`)

r = await fetch(url, { method: 'PUT', headers: { ...auth(token), 'if-none-match': '*' }, body: new Uint8Array([6]) })
check('PUT register again -> 409', r.status === 409, `${r.status}`)

r = await fetch(url, { headers: auth(other) })
check('GET with wrong token -> 401', r.status === 401, `${r.status}`)
r = await fetch(url, { method: 'PUT', headers: { ...auth(other), 'if-match': '"2"' }, body: new Uint8Array([7]) })
check('PUT with wrong token -> 401', r.status === 401, `${r.status}`)
r = await fetch(url, { method: 'DELETE', headers: auth(other) })
check('DELETE with wrong token -> 401', r.status === 401, `${r.status}`)
r = await fetch(url)
check('GET without token -> 401', r.status === 401, `${r.status}`)

r = await fetch(url, { method: 'PUT', headers: { ...auth(token), 'if-match': '"2"' }, body: new Uint8Array(4 * 1024 * 1024 + 1) })
check('PUT over size cap -> 413', r.status === 413, `${r.status}`)

r = await fetch(url, { method: 'OPTIONS', headers: { origin: 'https://example.com', 'access-control-request-method': 'PUT' } })
check('CORS preflight', r.status === 204 && r.headers.get('access-control-allow-origin') === '*', `${r.status}`)

r = await fetch(url, { method: 'DELETE', headers: auth(token) })
check('DELETE test vault -> 204', r.status === 204, `${r.status}`)
r = await fetch(url, { headers: auth(token) })
check('GET after delete -> 404', r.status === 404, `${r.status}`)

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed (test vault deleted)')
process.exit(failed ? 1 : 0)
