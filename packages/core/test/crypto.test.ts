import { describe, expect, it } from 'vitest'
import { decryptJson, deriveKeys, encryptJson, formatSyncKey, generateSyncKey, parseSyncKey } from '../src/crypto'

describe('sync key', () => {
  it('formats and parses back', () => {
    const k = generateSyncKey()
    const s = formatSyncKey(k)
    expect(s).toMatch(/^KS1(-[0-9A-Z]{4}){14}$/)
    expect(parseSyncKey(s)).toEqual(k)
  })
  it('accepts lower case, spaces and look-alike letters', () => {
    const k = generateSyncKey()
    const s = formatSyncKey(k).toLowerCase().replace(/-/g, ' ').replace(/1/g, 'l').replace(/0/g, 'o')
    expect(parseSyncKey(s)).toEqual(k)
  })
  it('catches a typo with the checksum', () => {
    const s = formatSyncKey(generateSyncKey())
    const i = 10
    const bad = s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1)
    expect(parseSyncKey(bad)).toBeNull()
    expect(parseSyncKey('hello')).toBeNull()
  })
  it('derives the same ids on every device, different per key', () => {
    const k = generateSyncKey()
    expect(deriveKeys(k)).toEqual(deriveKeys(new Uint8Array(k)))
    expect(deriveKeys(k).vaultId).toMatch(/^[0-9a-f]{32}$/)
    expect(deriveKeys(generateSyncKey()).vaultId).not.toBe(deriveKeys(k).vaultId)
    expect(deriveKeys(k).authToken).not.toContain(deriveKeys(k).vaultId)
  })
})

describe('encryption', () => {
  const keys = deriveKeys(generateSyncKey())
  it('round trips', () => {
    const value = { v: 1, text: 'héllo 🔐', list: [1, 2, 3] }
    const sealed = encryptJson(keys, value)
    expect(decryptJson(keys, sealed)).toEqual(value)
  })
  it('does not contain the plain text', () => {
    const sealed = encryptJson(keys, { secret: 'my-flag{abc}' })
    expect(new TextDecoder('latin1').decode(sealed)).not.toContain('my-flag')
  })
  it('uses a new nonce each time', () => {
    expect(encryptJson(keys, { a: 1 })).not.toEqual(encryptJson(keys, { a: 1 }))
  })
  it('fails with the wrong key or changed data', () => {
    const sealed = encryptJson(keys, { a: 1 })
    expect(() => decryptJson(deriveKeys(generateSyncKey()), sealed)).toThrow()
    const bad = new Uint8Array(sealed)
    bad[bad.length - 1] ^= 1
    expect(() => decryptJson(keys, bad)).toThrow()
  })
})
