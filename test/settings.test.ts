import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configDirEnv, loadSettings, saveSettings, sessionConfigDir, sharesSessions, validateSettings, type Settings } from '../src/settings.js'
import { validateProfile, ProfileError } from '../src/profile.js'
import { profileDir, type Paths } from '../src/paths.js'
import type { Profile } from '../src/types.js'

let home: string
let paths: Paths

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ccprov-set-'))
  paths = {
    claudeDir: join(home, '.claude'),
    configFile: join(home, '.config/ccprovider/providers.json'),
    settingsFile: join(home, '.config/ccprovider/settings.json'),
    dirsRoot: join(home, '.local/share/ccprovider/dirs'),
    cacheDir: join(home, '.cache/ccprovider'),
    binDir: join(home, 'bin'),
    defaultBinDir: join(home, '.local/share/ccprovider/bin'),
    usageDir: join(home, '.local/share/ccprovider/usage'),
  }
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

const profile = (over: Partial<Profile> = {}): Profile => ({
  baseUrl: 'https://api.z.ai/api/anthropic',
  aliases: { opus: 'm', sonnet: 'm', haiku: 's', subagent: 's' },
  ...over,
})
const oauth: Profile = { kind: 'oauth', baseUrl: '', aliases: {}, preset: 'claude' }
const off: Settings = { version: 1, shareSessions: false }
const on: Settings = { version: 1, shareSessions: true }

describe('validateSettings', () => {
  test('a missing file is the default: isolated', () => {
    expect(loadSettings(paths)).toEqual({ version: 1, shareSessions: false })
  })

  test('round-trips, and is private like the profile config', () => {
    saveSettings(paths, on)
    expect(loadSettings(paths)).toEqual(on)
    expect(statSync(paths.settingsFile).mode & 0o777).toBe(0o600)
  })

  test.each([
    ['not an object', 3],
    ['an unsupported version', { version: 2, shareSessions: true }],
    ['a non-boolean value', { version: 1, shareSessions: 'yes' }],
    ['a missing value', { version: 1 }],
  ])('refuses %s', (_label, raw) => {
    expect(() => validateSettings(raw, 'settings.json')).toThrow(ProfileError)
  })
})

describe('shareSessions on a profile', () => {
  test('passes through true, false and absent', () => {
    expect(validateProfile(profile({ shareSessions: true }), 't').shareSessions).toBe(true)
    expect(validateProfile(profile({ shareSessions: false }), 't').shareSessions).toBe(false)
    expect(validateProfile(profile(), 't').shareSessions).toBeUndefined()
  })

  test('a non-boolean is refused', () => {
    expect(() => validateProfile({ ...profile(), shareSessions: 'yes' }, 't')).toThrow(ProfileError)
  })

  // A silently dropped `true` would sit in the file looking set while the login stayed put.
  test('an oauth profile refuses the field outright', () => {
    expect(() => validateProfile({ ...oauth, shareSessions: true }, 't')).toThrow(ProfileError)
    expect(() => validateProfile({ ...oauth, shareSessions: false }, 't')).toThrow(ProfileError)
  })
})

describe('sharesSessions', () => {
  test('an override beats the global, both ways', () => {
    expect(sharesSessions(profile({ shareSessions: true }), off)).toBe(true)
    expect(sharesSessions(profile({ shareSessions: false }), on)).toBe(false)
  })

  test('no override inherits the global', () => {
    expect(sharesSessions(profile(), off)).toBe(false)
    expect(sharesSessions(profile(), on)).toBe(true)
  })

  test('oauth never shares, whatever the global says', () => {
    expect(sharesSessions(oauth, on)).toBe(false)
  })
})

describe('sessionConfigDir', () => {
  test('the real config dir when sharing, the profile dir when not', () => {
    expect(sessionConfigDir(paths, 'glm', profile({ shareSessions: true }), off)).toBe(paths.claudeDir)
    expect(sessionConfigDir(paths, 'glm', profile(), on)).toBe(paths.claudeDir)
    expect(sessionConfigDir(paths, 'glm', profile(), off)).toBe(profileDir(paths, 'glm'))
  })
})

// Measured on Claude Code: with CLAUDE_CONFIG_DIR unset it keeps its global state in
// ~/.claude.json; set to ~/.claude it moves it to ~/.claude/.claude.json. A shared session
// that exports the variable on its own therefore sees different onboarding, trust and
// user-scoped MCP servers than the plain `claude`, which is what it is meant to share with.
describe('configDirEnv', () => {
  test('a profile directory is always exported', () => {
    const dir = profileDir(paths, 'glm')
    expect(configDirEnv(paths, dir, {})).toBe(dir)
  })

  test('the real directory is left unset when the user never declared one', () => {
    expect(configDirEnv(paths, paths.claudeDir, {})).toBeNull()
  })

  test('the real directory is exported when the user declared it, as their plain claude has it', () => {
    expect(configDirEnv(paths, paths.claudeDir, { CLAUDE_CONFIG_DIR: paths.claudeDir })).toBe(paths.claudeDir)
  })

  test('a profile directory inherited from a parent session is not a declaration', () => {
    expect(configDirEnv(paths, paths.claudeDir, { CLAUDE_CONFIG_DIR: profileDir(paths, 'pclaude') })).toBeNull()
  })
})
