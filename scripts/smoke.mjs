// Quick live check of a sync server. Usage: node scripts/smoke.mjs [baseUrl]
// Makes random test vaults, checks the API (old format 1 and chunked format 2),
// then deletes the vaults. Uses random bytes, no real data.
import { randomBytes } from 'node:crypto'

const base = (process.argv[2] || process.env.SYNC_URL || 'https://sync.kryfsec.com').replace(/\/$/, '')
const id = randomBytes(16).toString('hex')
const token = randomBytes(32).toString('base64url')
const other = randomBytes(32).toString('base64url')
const url = `${base}/v1/vault/${id}`
const url2 = `${base}/v2/vault/${id}`
let failed = 0

function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (!ok) failed++
}
const auth = (t) => ({ authorization: `Bearer ${t}` })
const pack = (items) => Buffer.concat(items.flatMap(([name, data]) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  return [Buffer.from(name, 'hex'), len, data]
}))
const unpack = (buf) => {
  const out = new Map()
  for (let o = 0; o + 20 <= buf.length; ) {
    const len = buf.readUInt32BE(o + 16)
    out.set(buf.subarray(o, o + 16).toString('hex'), buf.subarray(o + 20, o + 20 + len))
    o += 20 + len
  }
  return out
}
const name = () => randomBytes(16).toString('hex')
const commit = (ifs, manifest, refs, t = token) =>
  fetch(url2, { method: 'PUT', headers: { ...auth(t), ...ifs, 'content-type': 'application/json' }, body: JSON.stringify({ manifest: Buffer.from(manifest).toString('base64'), refs }) })

const health = await fetch(`${base}/health`)
const hj = await health.json().catch(() => ({}))
check('GET /health', health.status === 200 && hj.ok === true, `${health.status} v${hj.version}`)

// ---- Format 1 (old apps) ----
let r = await fetch(url, { headers: auth(token) })
check('v1 GET missing vault -> 404', r.status === 404, `${r.status}`)
r = await fetch(url, { method: 'PUT', headers: auth(token), body: 'x' })
check('v1 PUT without If-Match -> 428', r.status === 428, `${r.status}`)
r = await fetch(url, { method: 'PUT', headers: { ...auth(token), 'if-none-match': '*' }, body: new Uint8Array([1, 2, 3]) })
check('v1 PUT first (register) -> 201 v1', r.status === 201 && r.headers.get('etag') === '"1"', `${r.status} ${r.headers.get('etag')}`)
r = await fetch(url, { headers: auth(token) })
let got = new Uint8Array(await r.arrayBuffer())
check('v1 GET -> same bytes, ETag "1"', r.status === 200 && r.headers.get('etag') === '"1"' && got.join() === '1,2,3', `${r.status}`)
r = await fetch(url, { method: 'PUT', headers: { ...auth(token), 'if-match': '"1"' }, body: new Uint8Array([4, 5]) })
check('v1 PUT If-Match "1" -> 200 v2', r.status === 200 && r.headers.get('etag') === '"2"', `${r.status} ${r.headers.get('etag')}`)
r = await fetch(url, { method: 'PUT', headers: { ...auth(token), 'if-match': '"1"' }, body: new Uint8Array([6]) })
const cj = await r.json().catch(() => ({}))
check('v1 PUT old version -> 409 with current version', r.status === 409 && cj.version === 2, `${r.status} v=${cj.version}`)
r = await fetch(url, { method: 'PUT', headers: { ...auth(token), 'if-none-match': '*' }, body: new Uint8Array([6]) })
check('v1 PUT register again -> 409', r.status === 409, `${r.status}`)
r = await fetch(url, { headers: auth(other) })
check('v1 GET with wrong token -> 401', r.status === 401, `${r.status}`)
r = await fetch(url, { method: 'PUT', headers: { ...auth(other), 'if-match': '"2"' }, body: new Uint8Array([7]) })
check('v1 PUT with wrong token -> 401', r.status === 401, `${r.status}`)
r = await fetch(url)
check('GET without token -> 401', r.status === 401, `${r.status}`)
r = await fetch(url, { method: 'PUT', headers: { ...auth(token), 'if-match': '"2"' }, body: new Uint8Array(4 * 1024 * 1024 + 1) })
check('v1 PUT over 4 MB -> 413', r.status === 413, `${r.status}`)

// ---- Format 2 (chunked) on the same vault: the upgrade path ----
r = await fetch(url2, { headers: auth(token) })
got = new Uint8Array(await r.arrayBuffer())
check('v2 GET old vault -> 200, x-vault-format 1, old bytes', r.status === 200 && r.headers.get('x-vault-format') === '1' && got.join() === '4,5', `${r.status} ${r.headers.get('x-vault-format')}`)
const n1 = name(), n2 = name(), n3 = name()
const d1 = randomBytes(900 * 1024), d2 = randomBytes(1000), d3 = randomBytes(2000)
r = await fetch(`${url2}/chunks`, { method: 'POST', headers: { ...auth(token), 'content-type': 'application/octet-stream' }, body: pack([[n1, d1], [n2, d2]]) })
let j = await r.json().catch(() => ({}))
check('v2 upload 2 chunks -> 200 stored 2', r.status === 200 && j.stored === 2, `${r.status} ${JSON.stringify(j)}`)
r = await fetch(`${url2}/chunks`, { method: 'POST', headers: { ...auth(other) }, body: pack([[n3, d3]]) })
check('v2 upload with wrong token -> 401', r.status === 401, `${r.status}`)
r = await fetch(`${url2}/chunks`, { method: 'POST', headers: auth(token), body: pack([[n3, randomBytes(1024 * 1024 + 1)]]) })
check('v2 chunk over 1 MB -> 400', r.status === 400, `${r.status}`)
r = await fetch(`${url2}/chunks`, { method: 'POST', headers: auth(token), body: new Uint8Array(8 * 1024 * 1024 + 1) })
check('v2 upload over 8 MB -> 413', r.status === 413, `${r.status}`)
r = await commit({ 'if-match': '"2"' }, randomBytes(200), [n1, n2, n3])
j = await r.json().catch(() => ({}))
check('v2 commit with a missing chunk -> 409 + missing list', r.status === 409 && j.missing?.length === 1 && j.missing[0] === n3, `${r.status} ${JSON.stringify(j.missing)}`)
r = await commit({ 'if-match': '"1"' }, randomBytes(200), [n1, n2])
check('v2 commit old version -> 409', r.status === 409 && r.headers.get('etag') === '"2"', `${r.status} ${r.headers.get('etag')}`)
r = await commit({}, randomBytes(200), [n1, n2])
check('v2 commit without If-Match -> 428', r.status === 428, `${r.status}`)
const m1 = randomBytes(300)
r = await commit({ 'if-match': '"2"' }, m1, [n1, n2])
check('v2 commit (upgrade to format 2) -> 200 v3', r.status === 200 && r.headers.get('etag') === '"3"', `${r.status} ${r.headers.get('etag')}`)
r = await fetch(url2, { headers: auth(token) })
got = Buffer.from(await r.arrayBuffer())
check('v2 GET -> manifest, format 2, ETag "3"', r.status === 200 && r.headers.get('x-vault-format') === '2' && got.equals(m1) && r.headers.get('etag') === '"3"', `${r.status}`)
r = await fetch(`${url2}/chunks/read`, { method: 'POST', headers: { ...auth(token), 'content-type': 'application/json' }, body: JSON.stringify({ names: [n1, n2, n3] }) })
let map = unpack(Buffer.from(await r.arrayBuffer()))
check('v2 read chunks -> both back, missing one listed', r.status === 200 && map.get(n1)?.equals(d1) && map.get(n2)?.equals(d2) && r.headers.get('x-missing') === n3, `${r.status} ${map.size} missing=${r.headers.get('x-missing')}`)
r = await fetch(`${url2}/chunks/read`, { method: 'POST', headers: auth(token), body: JSON.stringify({ names: ['nothex'] }) })
check('v2 read bad name -> 400', r.status === 400, `${r.status}`)

// Old app on an upgraded vault: a clear "please update", never broken data.
r = await fetch(url, { headers: auth(token) })
j = await r.json().catch(() => ({}))
check('v1 GET upgraded vault -> 410 please update', r.status === 410 && /update/i.test(j.error ?? ''), `${r.status} ${j.error}`)
r = await fetch(url, { method: 'PUT', headers: { ...auth(token), 'if-match': '"3"' }, body: new Uint8Array([9]) })
check('v1 PUT upgraded vault -> 410', r.status === 410, `${r.status}`)

// Replace n1 with n3: n1 is no longer used and is dropped.
r = await fetch(`${url2}/chunks`, { method: 'POST', headers: auth(token), body: pack([[n3, d3]]) })
r = await commit({ 'if-match': '"3"' }, randomBytes(300), [n2, n3])
check('v2 commit new set -> 200 v4', r.status === 200 && r.headers.get('etag') === '"4"', `${r.status}`)
r = await fetch(`${url2}/chunks/read`, { method: 'POST', headers: auth(token), body: JSON.stringify({ names: [n1, n2, n3] }) })
map = unpack(Buffer.from(await r.arrayBuffer()))
check('v2 unused chunk removed after commit (GC)', map.size === 2 && !map.has(n1) && r.headers.get('x-missing') === n1, `${map.size} missing=${r.headers.get('x-missing')}`)

r = await fetch(url2, { method: 'OPTIONS', headers: { origin: 'https://example.com', 'access-control-request-method': 'POST' } })
check('CORS preflight allows POST', r.status === 204 && r.headers.get('access-control-allow-origin') === '*' && /POST/.test(r.headers.get('access-control-allow-methods') ?? ''), `${r.status}`)

r = await fetch(url2, { method: 'DELETE', headers: auth(other) })
check('DELETE with wrong token -> 401', r.status === 401, `${r.status}`)
r = await fetch(url2, { method: 'DELETE', headers: auth(token) })
check('DELETE test vault -> 204', r.status === 204, `${r.status}`)
r = await fetch(url2, { headers: auth(token) })
check('GET after delete -> 404', r.status === 404, `${r.status}`)
r = await fetch(`${url2}/chunks/read`, { method: 'POST', headers: auth(token), body: JSON.stringify({ names: [n2] }) })
check('chunks gone after delete', r.status === 404, `${r.status}`)

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed (test vault deleted)')
process.exit(failed ? 1 : 0)
