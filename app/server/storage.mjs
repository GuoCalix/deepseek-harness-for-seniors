import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export async function readJson(file, fallback = null) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw new Error('Local data could not be read') }
}

export async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 })
    await fs.rename(temporary, file)
  } finally { await fs.rm(temporary, { force: true }).catch(() => undefined) }
}

// Desktop supplies Electron safeStorage (Keychain on macOS, DPAPI on Windows).
// The web development server holds new credentials in memory unless a codec is supplied.
export function credentialStore(directory, codec) {
  const file = path.join(directory, 'credentials.json')
  let memory
  let queue = Promise.resolve()
  return {
    async read() {
      if (memory !== undefined) return memory
      const encoded = await readJson(file)
      if (encoded && (!codec || !codec.isEncryptionAvailable())) throw new Error('Secure credential storage is unavailable')
      memory = encoded ? JSON.parse(codec.decryptString(Buffer.from(encoded.encrypted, 'base64'))) : {}
      return memory
    },
    write(value) {
      const operation = queue.then(async () => {
        if (codec) {
          if (!codec.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable')
          await writeJson(file, { version: 1, encrypted: codec.encryptString(JSON.stringify(value)).toString('base64') })
        }
        memory = value
      })
      queue = operation.catch(() => undefined)
      return operation
    },
    persistent: Boolean(codec),
  }
}
