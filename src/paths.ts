import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'

export interface Paths {
  /** The user's real Claude Code config dir — the symlink source. */
  claudeDir: string
  configFile: string
  dirsRoot: string
  cacheDir: string
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

export function getPaths(env: NodeJS.ProcessEnv = process.env, home = homedir()): Paths {
  const dirsRoot = join(xdg(env, 'XDG_DATA_HOME', '.local/share', home), 'ccprovider', 'dirs')

  // CLAUDE_CONFIG_DIR normally points at the user's real config. But inside a session
  // *we* launched it points at a profile dir — linking a profile to a profile would
  // nest state and eventually lose it. Fall back to ~/.claude in that case.
  const declared = env.CLAUDE_CONFIG_DIR
  const claudeDir =
    declared && declared.startsWith('/') && !isInside(declared, dirsRoot)
      ? declared
      : join(home, '.claude')

  return {
    claudeDir,
    configFile: join(xdg(env, 'XDG_CONFIG_HOME', '.config', home), 'ccprovider', 'providers.json'),
    dirsRoot,
    cacheDir: join(xdg(env, 'XDG_CACHE_HOME', '.cache', home), 'ccprovider'),
  }
}

export function profileDir(paths: Paths, name: string): string {
  return join(paths.dirsRoot, name)
}
