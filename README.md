# kryfsec-sync

End-to-end encrypted sync for [kryfsec](https://kryfsec.com): a small
Cloudflare Worker, and the shared sync code that the
[desktop](https://github.com/0xbasinas/kryfsec-desktop) and
[mobile](https://github.com/0xbasinas/kryfsec-mobile) apps use.

- No accounts. Devices pair with one sync key (QR code or text).
- The server stores one encrypted blob per vault. It never sees your data or your key.
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
3. The app turns its data into a document where every field has a timestamp
   (a hybrid logical clock), gzips it and encrypts it with AES-256-GCM.
4. Sync = download, decrypt, merge with local changes, encrypt, upload with
   `If-Match: "<version>"`. If another device saved in between, the server answers
   409 and the app tries again.

**Losing the sync key means losing the synced copy.** Nobody can recover it.
Your local data on each device stays.

### Encrypted blob format

```
[0x01 version][12-byte random nonce][AES-256-GCM ciphertext + 16-byte tag]
AAD = "kryfsec-sync v1 <vaultId>"
plaintext = gzip(JSON document)
```

## API

All vault requests need `Authorization: Bearer <auth token>`.

| Request | Result |
| --- | --- |
| `GET /health` | `200 {"ok":true,"service":"kryfsec-sync"}` |
| `GET /v1/vault/:id` | `200` blob, `ETag: "<version>"`. `404` if there is no vault yet. |
| `PUT /v1/vault/:id` with `If-None-Match: *` | Create the vault. The token's SHA-256 is saved; only that token works from now on. `201`, `ETag: "1"`. |
| `PUT /v1/vault/:id` with `If-Match: "<n>"` | Replace the blob if the version is still `n`. `200`, `ETag: "<n+1>"`. |
| version does not match | `409 {"version": <current>}` |
| no `If-Match` / `If-None-Match` | `428` |
| wrong or missing token | `401` |
| blob over 4 MB | `413` |
| too many requests | `429` (60/min per vault, about 120/min per IP) |
| `DELETE /v1/vault/:id` | `204`. Removes the vault. |

`:id` is 32 hex characters. CORS is open (`*`) because the token is the
only thing that gives access. The Worker never logs request bodies, and Workers
logs are off. Vaults nobody used for 400 days are removed.

### Storage

One SQLite-backed [Durable Object](https://developers.cloudflare.com/durable-objects/)
per vault, so saves to a vault happen one at a time and the version check is exact.
This works on the Workers **free plan**. No R2, KV or D1 needed.

## Repo layout

```
packages/core/src   shared code (clock, merge, crypto, sync round, HTTP client)
packages/core/test  unit tests (vitest)
worker/             the Cloudflare Worker + wrangler.jsonc
scripts/smoke.mjs   live API check: node scripts/smoke.mjs [url]
scripts/vendor.sh   copy packages/core/src into the apps (src/sync-core/)
docs/merging.md     how merging works, and how other apps do it
```

The apps keep a copy of `packages/core/src` in `src/sync-core/` (made by
`scripts/vendor.sh`), so each app builds on its own.

## Develop

```bash
npm install
npm test             # unit tests
npm run typecheck
npm run dev:worker   # local server on http://127.0.0.1:8787
node scripts/smoke.mjs http://127.0.0.1:8787
SYNC_URL=http://127.0.0.1:8787 npx vitest run live   # two devices through the real server
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
