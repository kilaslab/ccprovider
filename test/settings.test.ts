import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyGlobalShare,
  applyProfileShare,
  configDirEnv,
  describeShare,
  loadSettings,
  saveSettings,
  sessionConfigDir,
  sessionsStayNote,
  shareOverride,
  sharesSessions,
  sharingOnNotes,
  validateSettings,
  type Settings,
} from '../src/settings.js'
import { validateProfile, loadStore, saveStore, ProfileError } from '../src/profile.js'
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

// What the wizard stores for its "share chat sessions?" answer. Asked on every add and edit, so
// an answer that only repeats the default must not turn into a pin: flipping the global
// setting later would then skip that profile without anyone having chosen it.
describe('shareOverride', () => {
  test('an answer that matches the default is not stored for a profile with no override', () => {
    expect(shareOverride(false, undefined, off)).toBeUndefined()
    expect(shareOverride(true, undefined, on)).toBeUndefined()
  })

  test('an answer that differs from the default becomes the profile’s own override', () => {
    expect(shareOverride(true, undefined, off)).toBe(true)
    expect(shareOverride(false, undefined, on)).toBe(false)
  })

  test('re-confirming what the profile has leaves it alone, a deliberate override included', () => {
    expect(shareOverride(true, true, off)).toBe(true)
    expect(shareOverride(false, false, on)).toBe(false)
    // Same answer as the default, and the pin was a choice: kept, not quietly dropped.
    expect(shareOverride(true, true, on)).toBe(true)
    expect(shareOverride(false, false, off)).toBe(false)
  })

  // Regression: Yes to share, later No, with the default off, pinned the profile to false for good.
  test('flipping an override back to the default drops it, so the profile follows the default again', () => {
    expect(shareOverride(false, true, off)).toBeUndefined()
    expect(shareOverride(true, false, on)).toBeUndefined()
  })

  test('flipping an override away from the default pins the new answer', () => {
    expect(shareOverride(false, true, on)).toBe(false)
    expect(shareOverride(true, false, off)).toBe(true)
  })

  test('a profile that follows the default and is moved off it gets an override, then loses it again', () => {
    const first = shareOverride(true, undefined, off)
    expect(first).toBe(true)
    expect(shareOverride(false, first, off)).toBeUndefined()
  })
})

describe('describeShare', () => {
  test.each([
    ['an oauth profile', oauth, off, 'never shares — a Claude subscription keeps its login in its own directory'],
    ['an inheriting profile, global off', profile(), off, 'inherits — isolated'],
    ['an inheriting profile, global on', profile(), on, 'inherits — shares with ~/.claude'],
    ['an override to share', profile({ shareSessions: true }), off, 'shares with ~/.claude  (own override)'],
    ['an override to isolate', profile({ shareSessions: false }), on, 'isolated  (own override)'],
  ])('%s', (_label, p, settings, expected) => {
    expect(describeShare(p, settings)).toBe(expected)
  })
})

describe('applyProfileShare', () => {
  const store = (providers: Record<string, Profile>) => saveStore(paths, { version: 1, providers })
  /** The stored profile as written, not as validated: loading always yields the key. */
  const onDisk = (name: string) => JSON.parse(readFileSync(paths.configFile, 'utf8')).providers[name] as Record<string, unknown>

  test('sets an override and says what turning it on means', () => {
    store({ glm: profile() })
    const r = applyProfileShare(paths, 'glm', true)
    expect(loadStore(paths).providers.glm!.shareSessions).toBe(true)
    expect(r.changed).toBe(true)
    expect(r.done).toBe('"glm" now shares sessions with ~/.claude')
    expect(r.notes).toEqual(sharingOnNotes(paths, 'glm'))
    expect(r.notes[0]).toBe(sessionsStayNote(paths, 'glm'))
    expect(r.notes.join(' ')).toContain(profileDir(paths, 'glm'))
  })

  test('turning it off says nothing more', () => {
    store({ glm: profile({ shareSessions: true }) })
    const r = applyProfileShare(paths, 'glm', false)
    expect(loadStore(paths).providers.glm!.shareSessions).toBe(false)
    expect(r.done).toBe('"glm" has its own sessions again')
    expect(r.notes).toEqual([])
  })

  test('undefined drops the override, so the profile follows the global again', () => {
    store({ glm: profile({ shareSessions: true }) })
    const r = applyProfileShare(paths, 'glm', undefined)
    expect(onDisk('glm')).not.toHaveProperty('shareSessions')
    expect(r.changed).toBe(true)
    expect(r.done).toBe('"glm" follows the global setting again')
  })

  test('dropping an override that is not there changes nothing', () => {
    store({ glm: profile() })
    const r = applyProfileShare(paths, 'glm', undefined)
    expect(r.changed).toBe(false)
    expect(r.done).toBe('"glm" has no override of its own; it follows the global setting.')
  })

  // Following the default is only "turning it on" when the default is on.
  test('the sharing notes are for a profile that starts to share, not one that already did', () => {
    saveSettings(paths, on)
    store({ glm: profile() })
    expect(applyProfileShare(paths, 'glm', true).notes).toEqual([])
    store({ glm: profile({ shareSessions: false }) })
    expect(applyProfileShare(paths, 'glm', undefined).notes).toEqual(sharingOnNotes(paths, 'glm'))
  })

  test('refuses to make a subscription profile share, and leaves the store alone', () => {
    store({ work: oauth })
    expect(() => applyProfileShare(paths, 'work', true)).toThrow(ProfileError)
    expect(() => applyProfileShare(paths, 'work', false)).toThrow(ProfileError)
    expect(onDisk('work')).not.toHaveProperty('shareSessions')
  })

  // A script that loops `unset` over every profile must not fail on the subscription one.
  test('dropping the override of a subscription profile is a no-op, not an error', () => {
    store({ work: oauth })
    const r = applyProfileShare(paths, 'work', undefined)
    expect(r.changed).toBe(false)
    expect(r.done).toContain('never shares')
  })

  test('a name is matched the way every other command matches it', () => {
    store({ glm: profile() })
    expect(applyProfileShare(paths, 'GLM', true).done).toContain('"glm"')
    expect(loadStore(paths).providers.glm!.shareSessions).toBe(true)
  })

  test('an unknown profile is an error that names the ones there are', () => {
    store({ glm: profile() })
    expect(() => applyProfileShare(paths, 'nope', true)).toThrow(/No profile named "nope".*glm/)
  })

  // `constructor` is a valid name and an inherited property of every object.
  test('a profile called constructor is not confused with the object’s own', () => {
    store({ glm: profile() })
    expect(() => applyProfileShare(paths, 'constructor', true)).toThrow(ProfileError)
    store({ constructor: profile() })
    expect(applyProfileShare(paths, 'constructor', true).changed).toBe(true)
    expect(onDisk('constructor').shareSessions).toBe(true)
  })

  test('asking for what is already true writes nothing', () => {
    store({ glm: profile({ shareSessions: true }) })
    const before = readFileSync(paths.configFile, 'utf8')
    expect(applyProfileShare(paths, 'glm', true).changed).toBe(false)
    expect(readFileSync(paths.configFile, 'utf8')).toBe(before)
  })
})

describe('applyGlobalShare', () => {
  test('writes the private settings file', () => {
    const r = applyGlobalShare(paths, true)
    expect(loadSettings(paths).shareSessions).toBe(true)
    expect(statSync(paths.settingsFile).mode & 0o777).toBe(0o600)
    expect(r.done).toBe('shareSessions is now true for profiles without an override of their own')
  })

  test('turning it on notes that existing sessions stay put, only when a profile could share', () => {
    saveStore(paths, { version: 1, providers: { glm: profile() } })
    expect(applyGlobalShare(paths, true).notes.join(' ')).toContain('keeps the sessions it already has')

    saveSettings(paths, off)
    saveStore(paths, { version: 1, providers: { work: oauth } })
    expect(applyGlobalShare(paths, true).notes).toEqual([])
  })

  test('leaving it as it was writes nothing and says so', () => {
    const r = applyGlobalShare(paths, false)
    expect(r.changed).toBe(false)
    expect(r.done).toContain('already false')
    expect(existsSync(paths.settingsFile)).toBe(false)
  })

  test('turning it off, or leaving it as it was, has no notes', () => {
    saveSettings(paths, on)
    saveStore(paths, { version: 1, providers: { glm: profile() } })
    expect(applyGlobalShare(paths, true).notes).toEqual([])
    expect(applyGlobalShare(paths, false).notes).toEqual([])
  })
})
