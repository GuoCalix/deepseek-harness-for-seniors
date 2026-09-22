import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { expect, it } from 'vitest'
import { credentialStore } from '../server/storage.mjs'

it('awaits asynchronous OS codecs, persists only ciphertext and reloads credentials', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ai-old-crypto-test-'))
  const key = randomBytes(32)
  const codec = {
    async isEncryptionAvailable() { return true },
    async encryptString(value: string) { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv); const data = Buffer.concat([cipher.update(value), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), data]) },
    async decryptString(value: Buffer) { const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); cipher.setAuthTag(value.subarray(12, 28)); return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString() },
  }
  try {
    const credentials = credentialStore(directory, codec)
    await credentials.write({ account: { token: 'fixture-secret', issuer: 'https://platform.deepseek.com' } })
    expect(await readFile(path.join(directory, 'credentials.json'), 'utf8')).not.toContain('fixture-secret')
    expect(await credentialStore(directory, codec).read()).toMatchObject({ account: { token: 'fixture-secret' } })
    await expect(credentialStore(directory, { ...codec, isEncryptionAvailable: async () => false }).write({})).rejects.toThrow('unavailable')
  } finally { await rm(directory, { recursive: true, force: true }) }
})
