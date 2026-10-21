import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { declaredClaudeDir, profileDir, type Paths } from './paths.js'
import { ProfileError, getProfile, loadStore, saveStore, validateName } from './profile.js'
import { isOauth, type Profile } from './types.js'

/**
 * Install-wide settings, beside providers.json. Deliberately tiny: every knob here is one
 * a user might flip once and forget, so each carries its safety rule next to it.
 */
export interface Settings {
  version: 1
  /** Whether a profile without an override of its own runs its sessions in the real
   *  Claude config dir. Default false: isolated, as ccprovider has always behaved. */
  shareSessions: boolean
}

const EMPTY: Settings = { version: 1, shareSessions: false }

export function loadSettings(paths: Paths): Settings {
  if (!existsSync(paths.settingsFile)) return { ...EMPTY }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(paths.settingsFile, 'utf8'))
  } catch (e) {
    throw new ProfileError(`${paths.settingsFile} is not valid JSON: ${(e as Error).message}`)
  }
  return validateSettings(raw, paths.settingsFile)
}

export function saveSettings(paths: Paths, settings: Settings): void {
  mkdirSync(dirname(paths.settingsFile), { recursive: true })
  // Write-then-rename, like the profile config: a crash mid-write must not leave a
  // truncated file that would read as an error on every later run.
  const tmp = `${paths.settingsFile}.tmp`
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, paths.settingsFile)
}

export function validateSettings(raw: unknown, source = 'settings'): Settings {
  if (typeof raw !== 'object' || raw === null) throw new ProfileError(`${source}: expected an object`)
  const obj = raw as Record<string, unknown>
  if (obj.version !== 1) throw new ProfileError(`${source}: unsupported version ${String(obj.version)} (expected 1)`)
  if (typeof obj.shareSessions !== 'boolean') {
    throw new ProfileError(`${source}: "shareSessions" must be true or false`)
  }
  return { version: 1, shareSessions: obj.shareSessions }
}

/** The one place the sharing question is answered.
 *
 *  A per-profile override beats the global default. An oauth profile never shares, whatever
 *  the global says: its login lives in its own config directory, and sharing would put that
 *  credential beside every other profile's sessions. This is why a global `true` is safe. */
export function sharesSessions(profile: Profile, settings: Settings): boolean {
  if (profile.kind === 'oauth') return false
  return profile.shareSessions ?? settings.shareSessions
}

/** The config dir a session of this profile runs in. The one choice `use` and `env` must
 *  not drift apart on, so both go through here. */
export function sessionConfigDir(paths: Paths, name: string, profile: Profile, settings: Settings): string {
  return sharesSessions(profile, settings) ? paths.claudeDir : profileDir(paths, name)
}

/** What to export as CLAUDE_CONFIG_DIR for a session in `dir`: null for none.
 *
 *  Measured on Claude Code: with the variable unset it keeps its global state (onboarding,
 *  trust, user-scoped MCP servers) in ~/.claude.json, and set to ~/.claude it moves that to
 *  ~/.claude/.claude.json. A shared session that exported the variable on its own would
 *  therefore not share those with the plain `claude`. So the real directory is exported only
 *  when the user declared it themselves, which means their own `claude` runs with it set too. */
export function configDirEnv(paths: Paths, dir: string, env: NodeJS.ProcessEnv): string | null {
  if (dir !== paths.claudeDir) return dir
  return declaredClaudeDir(env, paths.dirsRoot) === null ? null : dir
}

/** What to store on a profile for the answer to "share chat sessions?", asked on every add
 *  and edit.
 *
 *  An answer that only repeats what the profile would get anyway is not stored: pinned, it
 *  would make a later change to the global setting skip that profile without anyone having
 *  chosen that. A profile that already has an override of its own keeps one, set to the answer.
 *  `undefined` means "follow the global default". */
export function shareOverride(answer: boolean, current: boolean | undefined, settings: Settings): boolean | undefined {
  if (current !== undefined) return answer
  return answer === settings.shareSessions ? undefined : answer
}

/** How a profile's sharing resolves, in words. Plain text: the caller decides what to dim. */
export function describeShare(profile: Profile, settings: Settings): string {
  if (isOauth(profile)) return 'never shares — a Claude subscription keeps its login in its own directory'
  if (profile.shareSessions === undefined) {
    return settings.shareSessions ? 'inherits — shares with ~/.claude' : 'inherits — isolated'
  }
  return profile.shareSessions ? 'shares with ~/.claude  (own override)' : 'isolated  (own override)'
}

/** What a profile gives up, and leaves behind, when it starts to share. */
export function sharingOnNotes(paths: Paths, name: string): string[] {
  return [
    `Sessions "${name}" already has stay in ${profileDir(paths, name)} — they will not show up in \`claude --resume\` from the shared directory, and \`ccprovider usage ${name}\` still reports them.`,
    'Per-profile agents and MCP servers are unavailable while it shares.',
  ]
}

export interface ShareChange {
  /** False when the setting already had that value and nothing was written. */
  changed: boolean
  /** One line saying what is now true. Plain text. */
  done: string
  /** Consequences worth a second line. Plain text. */
  notes: string[]
}

/** Set (`true`/`false`) or drop (`undefined`) one profile's own sharing override, and save.
 *
 *  The one writer behind `settings set|unset` and the `settings` menu, so what they refuse
 *  and what they say cannot drift apart. */
export function applyProfileShare(paths: Paths, name: string, value: boolean | undefined): ShareChange {
  const key = validateName(name)
  const store = loadStore(paths)
  const profile = getProfile(store, key)
  if (isOauth(profile)) {
    throw new ProfileError(`"${key}" is a Claude subscription profile: its login lives in its own config directory, so it cannot share sessions.`)
  }

  if (value === profile.shareSessions) {
    const done =
      value === undefined ? `"${key}" has no override of its own; it follows the global setting.`
      : value ? `"${key}" already shares sessions with ~/.claude`
      : `"${key}" already has its own sessions`
    return { changed: false, done, notes: [] }
  }

  const settings = loadSettings(paths)
  const before = sharesSessions(profile, settings)
  const next: Profile = { ...profile }
  if (value === undefined) delete next.shareSessions
  else next.shareSessions = value
  store.providers[key] = next
  saveStore(paths, store)

  const done =
    value === undefined ? `"${key}" follows the global setting again`
    : value ? `"${key}" now shares sessions with ~/.claude`
    : `"${key}" has its own sessions again`
  return { changed: true, done, notes: !before && sharesSessions(next, settings) ? sharingOnNotes(paths, key) : [] }
}

/** Set the install-wide default and save. It only reaches profiles without an override. */
export function applyGlobalShare(paths: Paths, value: boolean): ShareChange {
  const before = loadSettings(paths)
  saveSettings(paths, { version: 1, shareSessions: value })
  const done = `shareSessions is now ${value} for profiles without an override of their own`
  // A subscription profile never shares, so a store of nothing else has nothing to explain.
  const canShare = Object.values(loadStore(paths).providers).some((pr) => !isOauth(pr))
  return {
    changed: before.shareSessions !== value,
    done,
    notes: !before.shareSessions && value && canShare
      ? ['Each profile keeps the sessions it already has; what it starts from now on runs in ~/.claude.']
      : [],
  }
}
