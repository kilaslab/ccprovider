import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * The `/login` Claude Code keeps for a config directory. ccprovider never sends it anywhere, but
 * it has to stay with the directory: `rm` deletes it and `rename` moves it.
 *
 * On macOS it is a Keychain item named after the directory's path, not a file inside it, so
 * deleting or renaming the directory does not reach it: `rm` used to leave a working refresh
 * token behind for an account nothing used any more, and `rename` signed the profile out.
 * Elsewhere it is `.credentials.json` in the directory, which goes wherever the directory goes.
 *
 * A login is the bytes Claude Code stored, passed along as they are and never parsed.
 */
export interface ClaudeLogins {
  readonly name: string
  /** The login kept for `dir`, or null when it has none. */
  get(dir: string): Promise<Buffer | null>
  /** Whether `dir` has a login, without reading it. */
  has(dir: string): Promise<boolean>
  set(dir: string, login: Buffer): Promise<void>
  /** A login that is already gone counts as deleted. */
  delete(dir: string): Promise<void>
}

/** The Keychain service Claude Code files a config directory's login under (checked against
 *  Claude Code 2.1.309): `Claude Code-credentials-` and the first 8 hex digits of the SHA-256 of
 *  the NFC form of the path, exactly as CLAUDE_CONFIG_DIR gives it. */
export function keychainService(dir: string): string {
  return `Claude Code-credentials-${createHash('sha256').update(dir.normalize('NFC')).digest('hex').slice(0, 8)}`
}

/** The Keychain account Claude Code reads that item with: the login user, or the name it falls
 *  back to when the user's would not be safe on its own command line. */
export function keychainAccount(env: Record<string, string | undefined> = process.env): string {
  let user: string
  try {
    user = env.USER || userInfo().username
  } catch {
    user = 'claude-code-user'
  }
  return /^[a-zA-Z0-9._-]+$/.test(user) ? user : 'claude-code-user'
}

/**
 * The data on the `password:` line `security find-generic-password -g` prints to stderr:
 * `0x<hex>  "<escaped>"` for anything but printable ASCII without a backslash, the text between
 * the quotes otherwise, and nothing for an empty one. Read this way and not with `-w`, which
 * prints the hex form bare, so a login that is not plain ASCII would come back as its own hex
 * text and be written back as that.
 *
 * Errors never quote the line: it is the login.
 */
export function parsePassword(stderr: string): Buffer {
  const line = stderr.split('\n').find((l) => l.startsWith('password:'))
  if (line === undefined) throw new Error('`security` printed no password line')
  const rest = line.slice('password:'.length).trim()
  const hex = /^0x([0-9A-Fa-f]*)(?:\s|$)/.exec(rest)
  if (hex) return Buffer.from(hex[1]!, 'hex')
  if (rest.length >= 2 && rest.startsWith('"') && rest.endsWith('"')) return Buffer.from(rest.slice(1, -1), 'utf8')
  if (rest === '') return Buffer.alloc(0)
  throw new Error('`security` printed a password line in a form this version does not know')
}

/** 44 is `security`'s "item not found". */
const NOT_FOUND = 44
const exitCode = (e: unknown) => (e as { code?: number }).code

/** Claude Code's logins in the macOS Keychain, through the `security` CLI.
 *
 *  `set` hands the login to `security` as an argument, with the exposure `KeychainStore`
 *  describes. Claude Code does the same once a login outgrows the 4032-character line
 *  `security -i` reads, which one carrying MCP sign-ins soon does. */
export class KeychainLogins implements ClaudeLogins {
  readonly name = 'macOS Keychain'

  constructor(private readonly account: string = keychainAccount()) {}

  async get(dir: string): Promise<Buffer | null> {
    try {
      const { stderr } = await run('security', ['find-generic-password', '-g', '-a', this.account, '-s', keychainService(dir)])
      return parsePassword(stderr)
    } catch (e) {
      if (exitCode(e) === NOT_FOUND) return null
      throw this.failure('read', dir, e)
    }
  }

  async has(dir: string): Promise<boolean> {
    try {
      // Without -g or -w only the item's attributes are printed, and those need no access prompt.
      await run('security', ['find-generic-password', '-a', this.account, '-s', keychainService(dir)])
      return true
    } catch (e) {
      if (exitCode(e) === NOT_FOUND) return false
      throw this.failure('look up', dir, e)
    }
  }

  async set(dir: string, login: Buffer): Promise<void> {
    try {
      await run('security', ['add-generic-password', '-U', '-a', this.account, '-s', keychainService(dir), '-X', login.toString('hex')])
    } catch (e) {
      throw this.failure('write', dir, e)
    }
  }

  async delete(dir: string): Promise<void> {
    try {
      await run('security', ['delete-generic-password', '-a', this.account, '-s', keychainService(dir)])
    } catch (e) {
      if (exitCode(e) === NOT_FOUND) return
      throw this.failure('delete', dir, e)
    }
  }

  private failure(what: string, dir: string, e: unknown) {
    // Not e.message: for a write it holds the command line, and that holds the login.
    return new Error(
      `Could not ${what} the Claude login for ${dir} in the macOS Keychain (security exited ${exitCode(e) ?? '?'}). ` +
        'If you denied the access prompt, run again and allow it.',
    )
  }
}

/** Where the login is `.credentials.json` inside the directory: it moves and goes with it, so
 *  there is nothing to carry. */
export class InDirectoryLogins implements ClaudeLogins {
  readonly name = 'profile directory'
  async get(): Promise<Buffer | null> { return null }
  async has(dir: string) { return existsSync(join(dir, '.credentials.json')) }
  async set(): Promise<void> {}
  async delete(): Promise<void> {}
}

/** In-memory logins for tests. */
export class MemoryLogins implements ClaudeLogins {
  readonly name = 'memory'
  readonly map = new Map<string, Buffer>()
  async get(dir: string) { return this.map.get(dir) ?? null }
  async has(dir: string) { return this.map.has(dir) }
  async set(dir: string, login: Buffer) { this.map.set(dir, login) }
  async delete(dir: string) { this.map.delete(dir) }
}

export function detectLogins(platform: string = process.platform): ClaudeLogins {
  return platform === 'darwin' ? new KeychainLogins() : new InDirectoryLogins()
}
