import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getPaths } from '../paths.js'
import type { SecretStore } from './index.js'

/**
 * Fallback for headless Linux with no Secret Service available.
 *
 * AES-256-GCM with a key in a 0600 file beside the vault. Be clear-eyed about what
 * that buys: it protects secrets from ending up readable in a backup, a synced
 * dotfiles repo, or a stray `cat`. It does NOT protect against anything running as
 * this user, since that process can read the key file too. `doctor` says so out loud.
 */
export class FileStore implements SecretStore {
  readonly name = 'encrypted file (no OS keyring available)'
  private vaultPath: string
  private keyPath: string

  constructor(dir?: string) {
    const base = dir ?? dirname(getPaths().configFile)
    this.vaultPath = join(base, 'secrets.enc.json')
    this.keyPath = join(base, 'secrets.key')
  }

  private key(): Buffer {
    mkdirSync(dirname(this.keyPath), { recursive: true })
    if (!existsSync(this.keyPath)) {
      const k = randomBytes(32)
      writeAtomic(this.keyPath, k.toString('base64'))
      return k
    }
    const k = Buffer.from(readFileSync(this.keyPath, 'utf8').trim(), 'base64')
    // A truncated or zero-byte key file (an interrupted first write, a stray `touch`)
    // would otherwise make every get() return null — surfacing as the misleading
    // "no API key stored" — and every set() throw a raw RangeError.
    if (k.length !== 32) {
      throw new Error(
        `${this.keyPath} is corrupt (${k.length} bytes, expected 32). Delete it and ` +
          `re-enter your keys with \`ccprovider edit <name>\` — the stored values cannot be recovered without it.`,
      )
    }
    // Repair permissions on a pre-existing file, not just a freshly created one.
    chmodSync(this.keyPath, 0o600)
    return k
  }

  private read(): Record<string, string> {
    if (!existsSync(this.vaultPath)) return {}
    try {
      return JSON.parse(readFileSync(this.vaultPath, 'utf8')) as Record<string, string>
    } catch {
      return {}
    }
  }

  private write(v: Record<string, string>): void {
    mkdirSync(dirname(this.vaultPath), { recursive: true })
    // Write-then-rename: this file holds every profile's key, so a crash mid-write
    // must not lose all of them at once.
    writeAtomic(this.vaultPath, JSON.stringify(v, null, 2))
  }

  async get(account: string): Promise<string | null> {
    const blob = this.read()[account]
    if (!blob) return null
    try {
      const [ivB64, tagB64, dataB64] = blob.split('.')
      if (!ivB64 || !tagB64 || !dataB64) return null
      const d = createDecipheriv('aes-256-gcm', this.key(), Buffer.from(ivB64, 'base64'))
      d.setAuthTag(Buffer.from(tagB64, 'base64'))
      return Buffer.concat([d.update(Buffer.from(dataB64, 'base64')), d.final()]).toString('utf8')
    } catch {
      return null
    }
  }

  async set(account: string, secret: string): Promise<void> {
    const iv = randomBytes(12)
    const c = createCipheriv('aes-256-gcm', this.key(), iv)
    const data = Buffer.concat([c.update(secret, 'utf8'), c.final()])
    const vault = this.read()
    vault[account] = [iv.toString('base64'), c.getAuthTag().toString('base64'), data.toString('base64')].join('.')
    this.write(vault)
  }

  async delete(account: string): Promise<void> {
    const vault = this.read()
    delete vault[account]
    this.write(vault)
  }
}

function writeAtomic(path: string, contents: string): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, contents, { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, path)
}
