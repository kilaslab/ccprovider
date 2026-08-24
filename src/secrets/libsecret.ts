import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { SecretStore } from './index.js'
import { SERVICE } from './index.js'

const run = promisify(execFile)

/** Linux Secret Service via `secret-tool` (gnome-keyring, KWallet with the shim). */
export class LibsecretStore implements SecretStore {
  readonly name = 'libsecret (secret-tool)'

  static async available(): Promise<boolean> {
    try {
      await run('secret-tool', ['--version'])
      return true
    } catch {
      return false
    }
  }

  async get(account: string): Promise<string | null> {
    try {
      const { stdout } = await run('secret-tool', ['lookup', 'service', SERVICE, 'account', account])
      return stdout.replace(/\n$/, '') || null
    } catch {
      return null
    }
  }

  async set(account: string, secret: string): Promise<void> {
    // secret-tool reads the value from stdin, so it never appears in argv.
    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        'secret-tool',
        ['store', '--label', `${SERVICE}: ${account}`, 'service', SERVICE, 'account', account],
        (err) => (err ? reject(err) : resolve()),
      )
      child.stdin?.end(secret)
    })
  }

  async delete(account: string): Promise<void> {
    try {
      await run('secret-tool', ['clear', 'service', SERVICE, 'account', account])
    } catch {
      /* already gone */
    }
  }
}
