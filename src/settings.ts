import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { declaredClaudeDir, profileDir, type Paths } from './paths.js'
import { ProfileError } from './profile.js'
import type { Profile } from './types.js'

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
