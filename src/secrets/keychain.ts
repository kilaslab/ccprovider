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
    } catch (e) {
      // 44 is `security`'s "item not found" — a genuine absence. Anything else
      // (denied access, locked keychain) must not masquerade as "no key stored",
      // which would send the user to `ccprovider edit` for a permissions problem.
      const code = (e as { code?: number }).code
      if (code === 44) return null
      throw new Error(
        `Could not read the API key for "${account}" from the macOS Keychain ` +
          `(security exited ${code ?? '?'}). If you denied the access prompt, run again and allow it.`,
      )
    }
  }

  async set(account: string, secret: string): Promise<void> {
    await run('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', account, '-w', secret])
  }

  async delete(account: string): Promise<void> {
    try {
      await run('security', ['delete-generic-password', '-s', SERVICE, '-a', account])
    } catch (e) {
      // 44 is "not found": already gone, which is what the caller wanted. Anything else
      // (a denied prompt, a locked keychain) is a real failure — swallowing it made
      // `rename` believe the old entry was deleted and hid a failed rollback, leaving an
      // orphaned key that blocked the next rename onto that name.
      const code = (e as { code?: number }).code
      if (code === 44) return
      throw new Error(`Could not delete the API key entry for "${account}" from the macOS Keychain (security exited ${code ?? '?'}).`)
    }
  }
}
