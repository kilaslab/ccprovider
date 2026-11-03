import { describe, expect, test } from 'bun:test'
import { detectLogins, InDirectoryLogins, type ClaudeLogins, keychainAccount, keychainService, KeychainLogins, parsePassword } from '../src/claudelogin.js'

describe('keychainService', () => {
  // Read off a real Keychain: the item Claude Code 2.1.309 wrote for a profile with this
  // CLAUDE_CONFIG_DIR. If Claude Code changes its naming, this is the test that should say so.
  test('names the item the way Claude Code does', () => {
    expect(keychainService('/Users/kilas/.local/share/ccprovider/dirs/qonflo')).toBe('Claude Code-credentials-24c864f1')
  })

  test('hashes the NFC form, so a decomposed path finds the same item', () => {
    expect(keychainService('/dirs/café')).toBe(keychainService('/dirs/café'))
  })

  test('two directories never share an item', () => {
    expect(keychainService('/dirs/a')).not.toBe(keychainService('/dirs/b'))
  })
})

describe('keychainAccount', () => {
  test('is the login user', () => {
    expect(keychainAccount({ USER: 'kilas' })).toBe('kilas')
  })

  test("falls back the way Claude Code does when the name is not safe on a command line", () => {
    expect(keychainAccount({ USER: 'two words' })).toBe('claude-code-user')
    expect(keychainAccount({ USER: 'a"b' })).toBe('claude-code-user')
  })
})

describe('parsePassword', () => {
  test('printable text is taken from between the quotes, inner quotes and all', () => {
    expect(parsePassword('password: "{"claudeAiOauth":{"a":"b"}}"\n').toString()).toBe('{"claudeAiOauth":{"a":"b"}}')
  })

  // Regression guard for the reason -g is used over -w: `-w` prints this case as bare hex.
  test('the 0x form is decoded, not kept as hex text', () => {
    expect(parsePassword('password: 0x636166C3A9  "caf\\303\\251"\n').toString()).toBe('café')
  })

  test('a backslash forces the 0x form, and it round-trips', () => {
    const data = '{"a":"b\\\\c"}'
    const hex = Buffer.from(data).toString('hex').toUpperCase()
    expect(parsePassword(`password: 0x${hex}  "escaped"\n`).toString()).toBe(data)
  })

  test('an empty password is empty', () => {
    expect(parsePassword('password: \n').length).toBe(0)
  })

  test('finds the line among others', () => {
    expect(parsePassword('some notice\npassword: "x"\n').toString()).toBe('x')
  })

  test('never quotes the password in an error', () => {
    expect(() => parsePassword('password: s3cr3t-without-quotes\n')).toThrow(/form this version does not know/)
    try {
      parsePassword('password: s3cr3t-without-quotes\n')
    } catch (e) {
      expect((e as Error).message).not.toContain('s3cr3t')
    }
    expect(() => parsePassword('nothing here')).toThrow(/no password line/)
  })
})

describe('detectLogins', () => {
  test('the Keychain on macOS, the directory itself elsewhere', () => {
    expect(detectLogins('darwin')).toBeInstanceOf(KeychainLogins)
    expect(detectLogins('linux')).toBeInstanceOf(InDirectoryLogins)
  })

  test('in the directory there is nothing to carry: the file goes with it', async () => {
    const logins: ClaudeLogins = new InDirectoryLogins()
    expect(await logins.get('/nowhere')).toBeNull()
    await logins.set('/nowhere', Buffer.from('x'))
    await logins.delete('/nowhere')
    expect(await logins.has('/nowhere')).toBe(false)
  })
})
