# kryfsec-sync

End-to-end encrypted sync for [kryfsec](https://kryfsec.com): a small
Cloudflare Worker, and the shared sync code that the
[desktop](https://github.com/0xbasinas/kryfsec-desktop) and
[mobile](https://github.com/0xbasinas/kryfsec-mobile) apps use.

- No accounts. Devices pair with one sync key (QR code or text).
- The server stores small encrypted pieces per vault. It never sees your data or your key.
- Sync is incremental: only the pieces that changed go up or down. Vaults up to 64 MB
  (after gzip and encryption). See [docs/chunking.md](docs/chunking.md).
- Smart merging: per-field changes, line-by-line merge for notes, conflict copies
  only when two edits really clash. See [docs/merging.md](docs/merging.md).

Live server: `https://sync.kryfsec.com` (`/health` to check it).

## How it works

1. The desktop app makes a random 32-byte **sync key** and shows it as a QR code
   and as text (`KS1-XXXX-XXXX-…`). The phone scans or pastes it.
2. From the key, each device works out (HKDF-SHA256, salt `kryfsec-sync`):
   - a **vault id** (16 bytes, hex): where the data lives on the server,
   - an **auth token** (32 bytes): proves you may read and write it,
   - an **encryption key** (32 bytes): never leaves the device.
   - a **chunk id key** (32 bytes): names the encrypted pieces with an HMAC,
     so names say nothing about the content.
3. The app turns its data into a document where every field has a timestamp
   (a hybrid logical clock). The records are split into buckets; each bucket is
   gzipped, cut into pieces of at most 512 KB, and each piece is encrypted with
   AES-256-GCM. A small encrypted manifest lists the pieces.
4. Sync = download the manifest and the pieces that changed, merge with local
   changes, upload the pieces that changed, then commit the new manifest with
   `If-Match: "<version>"`. If another device saved in between, the server answers
   409 and the app tries again.

**Losing the sync key means losing the synced copy.** Nobody can recover it.
Your local data on each device stays.

### Encrypted format

```
[0x01 version][12-byte random nonce][AES-256-GCM ciphertext + 16-byte tag]
piece:    AAD = "kryfsec-sync v2 chunk <vaultId> <name>",  plaintext = slice of gzip(bucket JSON)
manifest: AAD = "kryfsec-sync v2 manifest <vaultId>",      plaintext = gzip(manifest JSON)
old file: AAD = "kryfsec-sync v1 <vaultId>",               plaintext = gzip(JSON document)
```

Details, sources and the reasons behind the design: [docs/chunking.md](docs/chunking.md).

## API

All vault requests need `Authorization: Bearer <auth token>`. `:id` is 32 hex
characters. The first write saves the token's SHA-256; only that token works
from then on.

| Request | Result |
| --- | --- |
| `GET /health` | `200 {"ok":true,"service":"kryfsec-sync","version":2}` |
| `GET /v2/vault/:id` | `200` encrypted manifest (`x-vault-format: 2`) or an old single file (`x-vault-format: 1`), `ETag: "<version>"`. `404` if none. |
| `POST /v2/vault/:id/chunks` | Upload pieces (binary pack, up to 8 MB, each piece up to 1 MB). `200`. |
| `POST /v2/vault/:id/chunks/read` | `{"names":[…]}` (up to 512) → the pieces as a pack, up to 8 MB per reply. |
| `PUT /v2/vault/:id` | `{"manifest":"<base64>","refs":[…]}` with `If-Match: "<n>"` (or `If-None-Match: *` to create). `200`/`201`, new `ETag`. |
| version does not match, or a piece is missing | `409` (`{"missing":[…]}` for missing pieces) |
| no `If-Match` / `If-None-Match` | `428` |
| wrong or missing token | `401` |
| vault over 64 MB, or over 128 MB stored | `413` |
| too many requests | `429` (120/min per vault, about 240/min per IP) |
| `DELETE /v2/vault/:id` | `204`. Removes the vault and all its pieces. |
| `GET/PUT/DELETE /v1/vault/:id` | The old single-file API (4 MB) for older apps. `410` "please update" once a newer app upgraded the vault. |

CORS is open (`*`) because the token is the only thing that gives access. The
Worker never logs request bodies, and Workers logs are off. Vaults nobody used
for 400 days are removed.

### Storage

One SQLite-backed [Durable Object](https://developers.cloudflare.com/durable-objects/)
per vault, so saves to a vault happen one at a time and the version check is exact.
This works on the Workers **free plan**. No R2, KV or D1 needed.

## Known limits

- 64 MB per vault after gzip and encryption (a journal with thousands of notes is
  usually under 1 MB). Old apps: 4 MB.
- One free Cloudflare account holds 5 GB of Durable Object storage in total, and
  100,000 Durable Object requests per day. Fine for a handful of people; a busy
  public server would need the paid plan.
- Each sync re-reads and hashes the whole document on the device to see what
  changed. With 20 MB of notes that takes a moment on a phone.
- Changing the number of buckets (when the data grows a lot) re-uploads
  everything once.
- The server sees how many pieces a vault has, their sizes and when they change,
  but not what is inside or which record is where.
- Rate limits are kept in memory per Worker instance, so they are best effort.

## Repo layout

```
packages/core/src   shared code (clock, merge, crypto, chunks, sync round, HTTP client)
packages/core/test  unit tests (vitest), run against the real Worker code on Node's SQLite
worker/             the Cloudflare Worker (router.ts, store.ts, index.ts) + wrangler.jsonc
scripts/smoke.mjs   live API check: node scripts/smoke.mjs [url]
scripts/vendor.sh   copy packages/core/src into the apps (src/sync-core/)
docs/merging.md     how merging works, and how other apps do it
docs/chunking.md    how data is split into encrypted pieces, limits, sources
```

The apps keep a copy of `packages/core/src` in `src/sync-core/` (made by
`scripts/vendor.sh`), so each app builds on its own.

## Develop

```bash
npm install          # Node 22.5 or newer (tests use its built-in SQLite)
npm test             # unit tests
npm run typecheck
npm run dev:worker   # local server on http://127.0.0.1:8787
node scripts/smoke.mjs http://127.0.0.1:8787
SYNC_URL=http://127.0.0.1:8787 npx vitest run live   # two devices + a 5 MB vault through the real server
LIVE_LOGS=20000 SYNC_URL=… npx vitest run live         # same with about 20 MB
```

## Self-host

1. Make a Cloudflare account (free plan is fine) and add your domain.
2. In `worker/wrangler.jsonc`, change `routes` to your hostname (or remove
   `routes` and set `"workers_dev": true`).
3. `npx wrangler login` and `npm run deploy`.
4. Check it: `node scripts/smoke.mjs https://your-host`.
5. Point the apps at it: they use `https://sync.kryfsec.com` by default
   (`DEFAULT_SYNC_URL` in `packages/core/src/transport.ts`; the desktop app also
   only allows that one host in `electron/main.ts`).

## License

MIT, (c) 2026 0xbasinas. See [LICENSE](LICENSE) and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
