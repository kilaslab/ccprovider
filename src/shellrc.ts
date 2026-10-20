import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/**
 * The managed PATH block in a shell startup file.
 *
 * The block is fenced by marker lines and is the only thing this module ever writes:
 * everything a user has around it is preserved byte for byte. Re-running replaces the
 * block in place instead of appending a second one.
 */

export const BLOCK_BEGIN = '# >>> ccprovider path >>>'
export const BLOCK_END = '# <<< ccprovider path <<<'

/** zsh → ~/.zshrc, bash → the file a bash of that platform reads — the interactive startup
 *  files.
 *
 *  Bash is not the same everywhere. On Linux an interactive shell reads ~/.bashrc. macOS opens
 *  every Terminal and iTerm tab as a login shell, which reads the first of ~/.bash_profile,
 *  ~/.bash_login and ~/.profile and does not read ~/.bashrc unless one of them sources it. So
 *  there the first of those that exists is the file, and ~/.bash_profile when none does:
 *  creating it where only ~/.profile exists would stop bash reading ~/.profile.
 *
 *  Anything else, or $SHELL unset, is null and the caller hands over the export line
 *  instead. The non-interactive files (~/.zshenv, ~/.profile) stay a manual choice: they
 *  are where a headless box needs the line, and which one is right depends on the setup —
 *  see docs/default-command.md. */
export function detectRcFile(
  env: NodeJS.ProcessEnv,
  home: string,
  platform: NodeJS.Platform = process.platform,
): { shell: 'zsh' | 'bash'; file: string } | null {
  const shell = basename(env.SHELL ?? '')
  if (shell === 'zsh') return { shell: 'zsh', file: join(home, '.zshrc') }
  if (shell === 'bash') {
    const name =
      platform === 'darwin'
        ? (['.bash_profile', '.bash_login', '.profile'].find((f) => existsSync(join(home, f))) ?? '.bash_profile')
        : '.bashrc'
    return { shell: 'bash', file: join(home, name) }
  }
  return null
}

/** Escape for inside double quotes, which the export line uses so `$PATH` expands:
 *  `\` and `"` would end the quoting, `$` and a backtick would expand. */
function dqEscape(s: string): string {
  return s.replace(/[\\"$`]/g, (ch) => `\\${ch}`)
}

const exportLine = (dir: string): string => `export PATH="${dqEscape(dir)}:$PATH"`

/** The block's export lines: the default-wrapper directory always, the launchers directory
 *  when asked for.
 *
 *  Each line puts its directory in front of PATH, so the last line ends up first. The
 *  launchers directory comes first in the block because Claude Code installs its own `claude`
 *  there, and the default wrapper has to be found before it. */
export function pathBlockLines(defaultBinDir: string, binDir: string | null): string[] {
  return [...(binDir ? [exportLine(binDir)] : []), exportLine(defaultBinDir)]
}

const withoutCr = (line: string): string => (line.endsWith('\r') ? line.slice(0, -1) : line)

/** Where the managed block sits in `lines`, as [begin, end] indexes.
 *
 *  A BEGIN with no END after it, or an END with no BEGIN before it, is a leftover and not a
 *  block: the block is the first END that has a BEGIN before it, opened by the nearest one.
 *  Taking the first BEGIN instead would let a leftover one swallow every line the user wrote
 *  between it and a block appended later. Marker lines match with a trailing `\r` ignored,
 *  so a file with Windows line endings is found too. */
function locate(lines: string[]): [number, number] | null {
  let begin = -1
  for (let i = 0; i < lines.length; i++) {
    const line = withoutCr(lines[i]!)
    if (line === BLOCK_BEGIN) begin = i
    else if (line === BLOCK_END && begin !== -1) return [begin, i]
  }
  return null
}

/** The block's current inner lines, or null when the content has none. */
export function readManagedBlock(content: string): string[] | null {
  const lines = content.split('\n')
  const at = locate(lines)
  return at ? lines.slice(at[0] + 1, at[1]).map(withoutCr) : null
}

/** Whether the file's block already puts `dir` on PATH. A file that cannot be read has no block. */
export function blockHasDir(file: string, dir: string): boolean {
  try {
    return readManagedBlock(readFileSync(file, 'utf8'))?.includes(exportLine(dir)) ?? false
  } catch {
    return false
  }
}

/** Create or replace the block; `unchanged` — with the file's bytes untouched — when these
 *  exact lines are already there.
 *
 *  Written in place, deliberately not write-then-rename: rc files are often symlinks into
 *  a dotfile repository, and a rename would replace the link with a real file. */
export function upsertManagedBlock(file: string, lines: string[]): 'created' | 'updated' | 'unchanged' {
  let content = ''
  try {
    content = readFileSync(file, 'utf8')
  } catch (e) {
    // Only a file that is not there yet is empty. Any other failure leaves the file as it
    // is: writing a block over a file that could not be read would lose what it holds.
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }

  const current = readManagedBlock(content)
  if (current && current.join('\n') === lines.join('\n')) return 'unchanged'

  const cr = content.includes('\r\n') ? '\r' : ''
  const block = [BLOCK_BEGIN, ...lines, BLOCK_END].map((l) => l + cr)
  const out = content.split('\n')
  const at = locate(out)

  let next: string
  if (at) {
    next = [...out.slice(0, at[0]), ...block, ...out.slice(at[1] + 1)].join('\n')
  } else {
    // No block (a leftover marker is left as found): append after one trailing newline.
    const base = content === '' ? [] : content.endsWith('\n') ? content.slice(0, -1).split('\n') : content.split('\n')
    next = [...base, ...block].join('\n') + '\n'
  }

  mkdirSync(dirname(file), { recursive: true })
  // The mode only applies at creation; an existing file keeps its own.
  writeFileSync(file, next, { mode: 0o600 })
  return content === '' ? 'created' : 'updated'
}
