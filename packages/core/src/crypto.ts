import { gcm } from '@noble/ciphers/aes.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import { gunzipSync, gzipSync, strFromU8, strToU8 } from 'fflate'

/**
 * Sync key: 32 random bytes made on the first device.
 * Everything else comes from it with HKDF-SHA256:
 * - vault id (who you are on the server, not secret)
 * - auth token (proves you may read and write the vault)
 * - encryption key (AES-256-GCM, never leaves your devices)
 */

const KEY_BYTES = 32
const CHECK_BYTES = 3
const PREFIX = 'KS1'
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ' // Crockford base32
const SALT = utf8ToBytes('kryfsec-sync')
const ENVELOPE_VERSION = 1
const NONCE_BYTES = 12

export interface VaultKeys {
  vaultId: string
  authToken: string
  encKey: Uint8Array
  /** Names chunks (HMAC), so the server cannot tell what is inside from the name. */
  idKey: Uint8Array
}

export function generateSyncKey(): Uint8Array {
  return randomBytes(KEY_BYTES)
}

function b32encode(bytes: Uint8Array): string {
  let out = ''
  let bits = 0
  let value = 0
  for (const b of bytes) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}

function b32decode(s: string): Uint8Array | null {
  const out: number[] = []
  let bits = 0
  let value = 0
  for (const ch of s) {
    const i = B32.indexOf(ch)
    if (i < 0) return null
    value = ((value << 5) | i) & 0xffffff
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return new Uint8Array(out)
}

/** "KS1-XXXX-XXXX-…" (14 groups). The last 3 bytes are a checksum to catch typos. */
export function formatSyncKey(key: Uint8Array): string {
  if (key.length !== KEY_BYTES) throw new Error('Sync key must be 32 bytes')
  const body = b32encode(concatBytes(key, sha256(key).slice(0, CHECK_BYTES)))
  return [PREFIX, ...(body.match(/.{1,4}/g) ?? [])].join('-')
}

/** Read a sync key typed, pasted or scanned. Returns null if it is not valid. */
export function parseSyncKey(text: string): Uint8Array | null {
  let s = text.toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0')
  if (s.startsWith(PREFIX) && s.length === PREFIX.length + 56) s = s.slice(PREFIX.length)
  if (s.length !== 56) return null
  const raw = b32decode(s)
  if (!raw || raw.length !== KEY_BYTES + CHECK_BYTES) return null
  const key = raw.slice(0, KEY_BYTES)
  const check = sha256(key).slice(0, CHECK_BYTES)
  for (let i = 0; i < CHECK_BYTES; i++) if (check[i] !== raw[KEY_BYTES + i]) return null
  return key
}

export function toBase64Url(bytes: Uint8Array): string {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += A[(n >> 18) & 63] + A[(n >> 12) & 63]
    if (i + 1 < bytes.length) out += A[(n >> 6) & 63]
    if (i + 2 < bytes.length) out += A[n & 63]
  }
  return out
}

export function deriveKeys(key: Uint8Array): VaultKeys {
  if (key.length !== KEY_BYTES) throw new Error('Sync key must be 32 bytes')
  const part = (info: string, len: number): Uint8Array => hkdf(sha256, key, SALT, utf8ToBytes(info), len)
  return {
    vaultId: bytesToHex(part('kryfsec vault id v1', 16)),
    authToken: toBase64Url(part('kryfsec auth v1', 32)),
    encKey: part('kryfsec enc v1', 32),
    idKey: part('kryfsec chunk id v1', 32)
  }
}

/** Extra data bound to each encrypted piece, so a piece cannot be moved to another vault or slot. */
export const AAD = {
  /** The old single-blob format (format 1). */
  blob: (vaultId: string): string => `kryfsec-sync v1 ${vaultId}`,
  manifest: (vaultId: string): string => `kryfsec-sync v2 manifest ${vaultId}`,
  chunk: (vaultId: string, name: string): string => `kryfsec-sync v2 chunk ${vaultId} ${name}`
}

/** AES-256-GCM. Output: [version][12-byte nonce][ciphertext + tag]. */
export function encryptBytes(keys: VaultKeys, plain: Uint8Array, aad: string): Uint8Array {
  const nonce = randomBytes(NONCE_BYTES)
  const sealed = gcm(keys.encKey, nonce, utf8ToBytes(aad)).encrypt(plain)
  return concatBytes(new Uint8Array([ENVELOPE_VERSION]), nonce, sealed)
}

/** Throws if the data was changed, or was made with another key or for another slot. */
export function decryptBytes(keys: VaultKeys, data: Uint8Array, aad: string): Uint8Array {
  if (data.length < 1 + NONCE_BYTES + 16 || data[0] !== ENVELOPE_VERSION) throw new Error('Unknown sync data format')
  const nonce = data.slice(1, 1 + NONCE_BYTES)
  return gcm(keys.encKey, nonce, utf8ToBytes(aad)).decrypt(data.slice(1 + NONCE_BYTES))
}

export const gzip = (b: Uint8Array): Uint8Array => gzipSync(b, { level: 6, mtime: 0 })
export const gunzip = (b: Uint8Array): Uint8Array => gunzipSync(b)
export { strFromU8, strToU8 }

/** JSON -> gzip -> AES-256-GCM. */
export function encryptJson(keys: VaultKeys, value: unknown, aad = AAD.blob(keys.vaultId)): Uint8Array {
  return encryptBytes(keys, gzip(strToU8(JSON.stringify(value))), aad)
}

/** Throws if the data was changed, or was made with another key. */
export function decryptJson(keys: VaultKeys, data: Uint8Array, aad = AAD.blob(keys.vaultId)): unknown {
  return JSON.parse(strFromU8(gunzip(decryptBytes(keys, data, aad))))
}

/** Keyed name for a piece of data: HMAC-SHA256 with the chunk id key, 16 bytes as hex. */
export function chunkName(keys: VaultKeys, data: Uint8Array | string): string {
  const bytes = typeof data === 'string' ? strToU8(data) : data
  return bytesToHex(hmac(sha256, keys.idKey, bytes).slice(0, 16))
}

/** Random device id, used to break ties between two changes at the same moment. */
export function newDeviceId(): string {
  return b32encode(randomBytes(5)).toLowerCase()
}
