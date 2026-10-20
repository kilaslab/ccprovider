import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'

export interface Paths {
  /** The user's real Claude Code config dir — the symlink source. */
  claudeDir: string
  configFile: string
  /** Install-wide settings, beside providers.json. */
  settingsFile: string
  dirsRoot: string
  cacheDir: string
  /** Where per-profile launcher commands are installed. Must be on the user's PATH
   *  for `glm` to resolve as a command; `doctor` checks that it is. */
  binDir: string
  /** Where the wrapper that makes a profile the plain `claude` command lives. A directory
   *  of its own, because `claude` in binDir would be Claude Code's own symlink, rewritten
   *  by its updater. It only takes effect once it comes before that `claude` on PATH. */
  defaultBinDir: string
  /** One token-usage ledger per profile (`<name>.json`). Data and not cache: it outlives
   *  the transcripts it was read from, which Claude Code deletes after a while. */
  usageDir: string
}

function xdg(env: NodeJS.ProcessEnv, varName: string, fallback: string, home: string): string {
  const v = env[varName]
  return v && v.startsWith('/') ? v : join(home, fallback)
}

export function isInside(child: string, parent: string): boolean {
  const c = resolve(child)
  const p = resolve(parent)
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep)
}

/** The config dir the user declared in CLAUDE_CONFIG_DIR, or null when they did not — an
 *  unset variable, or one inside a session this tool launched, which names a profile dir. */
export function declaredClaudeDir(env: NodeJS.ProcessEnv, dirsRoot: string): string | null {
  const declared = env.CLAUDE_CONFIG_DIR
  return declared && declared.startsWith('/') && !isInside(declared, dirsRoot) ? declared : null
}

export function getPaths(env: NodeJS.ProcessEnv = process.env, home = homedir()): Paths {
  const dirsRoot = join(xdg(env, 'XDG_DATA_HOME', '.local/share', home), 'ccprovider', 'dirs')

  // CLAUDE_CONFIG_DIR normally points at the user's real config. But inside a session
  // *we* launched it points at a profile dir — linking a profile to a profile would
  // nest state and eventually lose it. Fall back to ~/.claude in that case.
  const claudeDir = declaredClaudeDir(env, dirsRoot) ?? join(home, '.claude')

  return {
    claudeDir,
    configFile: join(xdg(env, 'XDG_CONFIG_HOME', '.config', home), 'ccprovider', 'providers.json'),
    settingsFile: join(xdg(env, 'XDG_CONFIG_HOME', '.config', home), 'ccprovider', 'settings.json'),
    dirsRoot,
    cacheDir: join(xdg(env, 'XDG_CACHE_HOME', '.cache', home), 'ccprovider'),
    // ~/.local/bin is where Claude Code itself installs `claude`, so it is already on
    // the PATH of anyone who can run this tool. Overridable for tests and for people
    // who keep launchers elsewhere.
    binDir: env.CCPROVIDER_BIN_DIR?.startsWith('/') ? env.CCPROVIDER_BIN_DIR : join(home, '.local', 'bin'),
    defaultBinDir: env.CCPROVIDER_DEFAULT_BIN_DIR?.startsWith('/')
      ? env.CCPROVIDER_DEFAULT_BIN_DIR
      : join(xdg(env, 'XDG_DATA_HOME', '.local/share', home), 'ccprovider', 'bin'),
    usageDir: join(xdg(env, 'XDG_DATA_HOME', '.local/share', home), 'ccprovider', 'usage'),
  }
}

export function profileDir(paths: Paths, name: string): string {
  return join(paths.dirsRoot, name)
}
