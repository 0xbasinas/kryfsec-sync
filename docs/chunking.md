# How kryfsec splits synced data into chunks

Until now each vault was one encrypted file, capped at 4 MB. Every sync uploaded
and downloaded the whole file. Now the data is cut into small encrypted pieces,
and a sync only moves the pieces that changed.

## What others do

| App | How it stores encrypted data | What it sends on a change |
| --- | --- | --- |
| [restic](https://restic.readthedocs.io/en/stable/100_references.html) | Files are cut into chunks (content-defined, [512 KiB to 8 MiB, about 1 MiB on average](https://restic.net/blog/2015-09-12/restic-foundation1-cdc/)). A chunk is named by the SHA-256 of its plain content, packed into pack files, listed in an index. | Only chunks the repo does not have yet. |
| [borg](https://borgbackup.readthedocs.io/en/latest/internals/security.html) | Like restic, but a chunk's id is an **HMAC** with a secret key, not a plain hash, so the server cannot guess what a chunk holds by hashing known files. The id is also bound into the encryption. | Only new chunks. |
| [Standard Notes](https://github.com/standardnotes/app/blob/main/packages/snjs/specification.md) | Every note is encrypted on its own ([encryption](https://standardnotes.com/help/security/encryption)). | Changed items, paged with a sync token and a limit per request. |
| [Etebase](https://docs.etebase.com/overview) | Items with revisions inside collections ([items](https://docs.etebase.com/guides/using_items), [protocol](https://docs.etebase.com/protocol-specs/introduction)). | Only changes since a stoken, in batches; commits check the revision (a transaction). |
| [Obsidian Sync](https://help.obsidian.md/sync/security) | Each file is encrypted on the device. | Changed files. |
| [Bitwarden](https://bitwarden.com/help/bitwarden-security-white-paper/) | Each vault item is encrypted on its own. | A full sync downloads the whole (small) vault. |
| [Anytype (any-sync)](https://tech.anytype.io/any-sync/overview) | Objects made of signed, encrypted change records in a tree. | New change records. |

Two ideas come up again and again:

1. **Name a piece by its content** (restic, borg). The same content gets the same
   name, so an unchanged piece is never sent twice. borg uses a keyed hash
   (HMAC) so names give nothing away.
2. **Keep a small list of the pieces and commit it with a version check**
   (restic's index, Etebase's transactions). Readers then always see a whole,
   matching set.

## What kryfsec does

A simple version of the two ideas above, sized for a personal journal.

1. **Buckets by record.** Every record (a log, a lab, a goal…) goes to one of `n`
   buckets, picked by a hash of its collection and id. A record always lands in
   the same bucket, so editing one note only changes its bucket. Splitting by
   byte offset (for example "16 MB into 4 pieces of 4 MB") would be simpler, but
   adding one line near the start would shift every byte after it and change
   every piece.
2. **How many buckets.** `n` is a power of two from 8 to 4096, about one bucket
   per 256 KB of data, so a bucket is usually one piece. It only grows when the
   data grows a lot (it stays put unless it would be 8 times off), because a new
   `n` means re-uploading everything once.
3. **Pieces.** Each bucket is turned into JSON (keys sorted, so every device
   writes the same bytes), gzipped, and cut into pieces of at most 512 KB. Each
   piece is encrypted on its own with AES-256-GCM. The data bound to it (AAD) is
   `kryfsec-sync v2 chunk <vaultId> <name>`, so a piece cannot be moved to
   another vault or swapped with another piece.
4. **Names that leak nothing.** A piece's name is `HMAC-SHA256(idKey, piece)`,
   cut to 16 bytes. `idKey` is a new key derived from the sync key (HKDF info
   `kryfsec chunk id v1`). The server only sees random-looking names and sizes.
5. **Manifest.** A small encrypted list: `n`, and for each bucket a keyed hash of
   its JSON plus its piece names and sizes. Encrypted with AAD
   `kryfsec-sync v2 manifest <vaultId>`. The server cannot read it; the app
   also sends the plain list of piece names (`refs`) so the server knows what to
   keep.
6. **Upload (push).** Work out the buckets, compare each bucket's hash with the
   manifest on the server, and upload only pieces the server does not have, in
   batches of up to 4 MB. Then commit the new manifest with
   `If-Match: "<version>"`. If another device committed first, the server says
   409; the app downloads, merges and tries again (up to 5 times). If nothing
   changed, nothing is uploaded and nothing is committed.
7. **Download (pull).** Get the manifest, then only the pieces of buckets whose
   hash differs from this device's last sync, in batches. Unchanged buckets come
   from the copy saved on the device. Even inside a changed bucket, pieces that
   did not change are rebuilt locally rather than downloaded. Each bucket is
   checked against its hash in the manifest.
8. **Cleaning up.** A commit drops pieces the old manifest used and the new one
   does not. Pieces that were uploaded but never committed (a sync that stopped
   half way) are dropped after a day.

The server is still one SQLite-backed Durable Object per vault, so commits to a
vault happen one at a time and the version check is exact.

## Old vaults and old apps

- A vault saved by an older app is one encrypted file ("format 1"). A newer app
  reads it, merges, and commits it as chunks on its next good sync. The server
  then deletes the old file.
- An older app that talks to an upgraded vault gets
  `410 This vault was upgraded by a newer kryfsec. Please update this app.`
  It never gets data it cannot read, and it cannot overwrite the new format.
- Old apps keep working with vaults that no newer app has touched yet.

## Limits (Cloudflare free plan)

| What | Limit |
| --- | --- |
| Vault size (all pieces in the current manifest, encrypted, after gzip) | 64 MB |
| Everything stored for one vault, including uploads not committed yet | 128 MB |
| One piece | 512 KB from the app, 1 MB max on the server |
| One upload request | 4 MB from the app, 8 MB max on the server |
| One download reply | up to 8 MB; the app asks again for the rest |
| Names per download request | 512 |
| Manifest | 1 MB |
| Requests | 120 per minute per vault, about 240 per minute per IP |
| Old apps (format 1) | one file up to 4 MB |
| Unused vaults | removed after 400 days; a vault that never got a first commit after 7 days |

Why these numbers: on the free plan a SQLite Durable Object can store
1 GB, one row can hold at most 2 MB, and an account gets 5 GB in total,
100,000 Durable Object requests per day, 5 million rows read and 100,000 rows
written per day ([Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/),
[pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)).
64 MB per vault leaves room for many people on one free account; a typical
journal is well under 1 MB.

## Wire format

```
piece      = [0x01][12-byte nonce][AES-256-GCM(gzip-bytes slice) + tag]
             AAD "kryfsec-sync v2 chunk <vaultId> <name>"
name       = hex(HMAC-SHA256(idKey, gzip-bytes slice)[0..16])
manifest   = [0x01][nonce][AES-256-GCM(gzip(JSON))]  AAD "kryfsec-sync v2 manifest <vaultId>"
JSON       = {"v":2,"n":<buckets>,"gc":<cleanup stamp>,"b":[{"h":<bucket hash>,"p":[[name,size],…]},…]}
pack       = ([16-byte name][u32 big-endian length][piece])*   (upload body and download reply)
```

| Request | Result |
| --- | --- |
| `GET /v2/vault/:id` | `200` manifest (`x-vault-format: 2`) or the old file (`x-vault-format: 1`), `ETag: "<version>"`. `404` if none. |
| `POST /v2/vault/:id/chunks` (pack) | `200 {"stored":n,"had":m}`. `400` bad piece, `413` too big or storage full. |
| `POST /v2/vault/:id/chunks/read` `{"names":[…]}` | `200` pack. Names it does not have are listed in `x-missing`. Stops before 8 MB. |
| `PUT /v2/vault/:id` `{"manifest":"<base64>","refs":[…]}` with `If-Match: "<n>"` or `If-None-Match: *` | `200`/`201` with the new `ETag`. `409` if the version moved on, or `409 {"missing":[…]}` if a piece is not uploaded. `413` over 64 MB. `428` without a condition. |
| `DELETE /v2/vault/:id` | `204`. Removes everything. |

## Where the code is

- `packages/core/src/chunks.ts`: buckets, pieces, manifest, rebuilding the doc
- `packages/core/src/crypto.ts`: keys (`idKey`), `encryptBytes`, `chunkName`
- `packages/core/src/transport.ts`: the v2 HTTP client, batching, the pack format
- `packages/core/src/engine.ts`: one sync round, upgrade from format 1
- `worker/src/store.ts`: the vault storage (tables, commit, cleanup, caps)
- `worker/src/router.ts`: HTTP checks and rate limits
- `packages/core/test/chunks.test.ts`: tests, run against the real Worker code on Node's SQLite
