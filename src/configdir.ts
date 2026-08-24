import { lstatSync, existsSync, mkdirSync, readdirSync, readlinkSync, rmdirSync, symlinkSync, unlinkSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { isInside } from './paths.js'

/**
 * Entries shared with the user's real ~/.claude via symlink.
 *
 * An allowlist, deliberately. Anything Claude Code invents in a future version stays
 * profile-local by default — "the new thing isn't shared yet" is a recoverable
 * surprise; two profiles writing the same state file is not.
 */
export const LINKED_ENTRIES = [
  'skills',
  'plugins',
  'rules',
  'agents',
  'commands',
  'CLAUDE.md',
  'settings.json',
] as const

export type LinkAction = 'created' | 'repaired' | 'ok' | 'removed-dangling' | 'skipped-real'

export interface LinkResult {
  entry: string
  action: LinkAction
  detail?: string
}

/**
 * Make the profile dir's shared entries point at the real config dir.
 *
 * Runs before every launch, so a skill or plugin installed later shows up without
 * re-running setup. Only entries that actually exist in the source are linked.
 */
export function reconcileLinks(dir: string, claudeDir: string): LinkResult[] {
  mkdirSync(dir, { recursive: true })
  const results: LinkResult[] = []

  for (const entry of LINKED_ENTRIES) {
    const src = join(claudeDir, entry)
    const dest = join(dir, entry)
    const destLink = lstatSafe(dest)

    if (!existsSync(src)) {
      // Source gone (or never existed). Drop a link pointing at nothing.
      if (destLink?.isSymbolicLink()) {
        unlinkSync(dest)
        results.push({ entry, action: 'removed-dangling' })
      }
      continue
    }

    if (!destLink) {
      symlinkSync(src, dest)
      results.push({ entry, action: 'created' })
      continue
    }

    if (destLink.isSymbolicLink()) {
      const current = readlinkSync(dest)
      if (current === src) {
        results.push({ entry, action: 'ok' })
      } else {
        unlinkSync(dest)
        symlinkSync(src, dest)
        results.push({ entry, action: 'repaired', detail: `was -> ${current}` })
      }
      continue
    }

    // A real file or directory sits where a link belongs. Never clobber it —
    // it may hold the only copy of something the user put there by hand.
    results.push({
      entry,
      action: 'skipped-real',
      detail: `${dest} exists as a real ${destLink.isDirectory() ? 'directory' : 'file'}`,
    })
  }

  return results
}

/**
 * Remove a profile directory without ever following a symlink out of it.
 *
 * fs.rm({recursive:true}) also unlinks symlinks rather than descending into them, so
 * it would be safe here too. This is spelled out anyway: it is the one operation that
 * could delete the user's real ~/.claude/skills and ~/.claude/plugins, and an explicit
 * lstat-before-descent makes that guarantee auditable and independent of Node's
 * rimraf semantics changing under us.
 */
export function removeProfileDir(dir: string, dirsRoot: string): void {
  // Refuse to operate anywhere but under our own data root, even if called wrongly.
  if (!isInside(dir, dirsRoot) || dir === dirsRoot) {
    throw new Error(`Refusing to remove ${dir}: outside the ccprovider profile root.`)
  }
  if (!existsSync(dir) && !lstatSafe(dir)) return
  removeRecursive(dir)
}

function removeRecursive(path: string): void {
  const st = lstatSafe(path)
  if (!st) return

  if (st.isSymbolicLink()) {
    unlinkSync(path) // removes the link itself; the target is untouched
    return
  }
  if (!st.isDirectory()) {
    unlinkSync(path)
    return
  }
  for (const child of readdirSync(path)) {
    removeRecursive(join(path, child))
  }
  rmdirSync(path)
}

function lstatSafe(p: string) {
  try {
    return lstatSync(p)
  } catch {
    return null
  }
}

/** Entries that are links, and where they point — for `ls` and `doctor`. */
export function inspectLinks(dir: string): Array<{ entry: string; target: string | null; broken: boolean }> {
  return LINKED_ENTRIES.map((entry) => {
    const p = join(dir, entry)
    const st = lstatSafe(p)
    if (!st) return { entry, target: null, broken: false }
    if (!st.isSymbolicLink()) return { entry, target: '(real file, not linked)', broken: false }
    const target = readlinkSync(p)
    let broken = false
    try {
      realpathSync(p)
    } catch {
      broken = true
    }
    return { entry, target, broken }
  })
}
