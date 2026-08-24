import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { SecretStore } from './index.js'
import { SERVICE } from './index.js'

const run = promisify(execFile)

/** macOS Keychain via the `security` CLI.
 *
 *  Note: `security` takes the secret as an argv value, so it is briefly visible to
 *  `ps` for other processes running as this user. execFile (never a shell) keeps it
 *  out of shell history and avoids quoting bugs; the argv exposure is inherent to
 *  the tool and is the same tradeoff every keychain wrapper makes. */
export class KeychainStore implements SecretStore {
  readonly name = 'macOS Keychain'

  async get(account: string): Promise<string | null> {
    try {
      const { stdout } = await run('security', ['find-generic-password', '-s', SERVICE, '-a', account, '-w'])
      return stdout.replace(/\n$/, '')
    } catch {
      return null
    }
  }

  async set(account: string, secret: string): Promise<void> {
    await run('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', account, '-w', secret])
  }

  async delete(account: string): Promise<void> {
    try {
      await run('security', ['delete-generic-password', '-s', SERVICE, '-a', account])
    } catch {
      /* already gone */
    }
  }
}
