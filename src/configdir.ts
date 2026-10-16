import { lstatSync, existsSync, mkdirSync, readdirSync, readlinkSync, rmdirSync, symlinkSync, unlinkSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
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

export type LinkAction = 'created' | 'repaired' | 'ok' | 'removed-dangling' | 'skipped-real' | 'merged'

/** The one entry a profile may also keep its own files in: ccprovider-installed agents
 *  live beside the shared ones. See `reconcileMergedAgents`. */
const MERGED_ENTRY = 'agents'

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
    let destLink = lstatSafe(dest)

    if (entry === MERGED_ENTRY && destLink?.isDirectory()) {
      if (ownEntries(dest, src).length) {
        results.push(...reconcileMergedAgents(dest, src))
        continue
      }
      // Nothing of the profile's own is left, only links: go back to sharing the whole
      // directory, so a profile without ccprovider agents behaves exactly as before.
      for (const child of readdirSync(dest)) unlinkSync(join(dest, child))
      rmdirSync(dest)
      destLink = null
    }

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
 * Make the profile's `agents` a directory of its own, so an agent can be written into
 * this profile alone. A wholesale link to ~/.claude/agents is replaced by per-file links
 * — unlinking it never touches its target — and the shared agents stay visible.
 */
export function ensureOwnAgentsDir(dir: string, claudeDir: string): string {
  const dest = join(dir, MERGED_ENTRY)
  if (lstatSafe(dest)?.isSymbolicLink()) unlinkSync(dest)
  mkdirSync(dest, { recursive: true })
  reconcileMergedAgents(dest, join(claudeDir, MERGED_ENTRY))
  return dest
}

/**
 * The profile's own agents beside per-file links to the shared ones.
 *
 * Only links pointing into ~/.claude/agents are ccprovider's to manage here: they are
 * added, repaired and dropped as the shared directory changes. Anything else — a file,
 * or a link of the user's own to somewhere else — belongs to the profile and is never
 * touched; on a name clash it wins over the shared agent.
 */
function reconcileMergedAgents(dest: string, src: string): LinkResult[] {
  const results: LinkResult[] = []
  const shared = existsSync(src) ? readdirSync(src) : []

  for (const child of readdirSync(dest)) {
    const p = join(dest, child)
    if (isSharedLink(p, src) && !shared.includes(child)) {
      unlinkSync(p)
      results.push({ entry: `${MERGED_ENTRY}/${child}`, action: 'removed-dangling' })
    }
  }
  for (const child of shared) {
    const target = join(src, child)
    const p = join(dest, child)
    const st = lstatSafe(p)
    if (!st) {
      symlinkSync(target, p)
    } else if (isSharedLink(p, src)) {
      if (readlinkSync(p) !== target) {
        unlinkSync(p)
        symlinkSync(target, p)
      }
    } else {
      results.push({ entry: `${MERGED_ENTRY}/${child}`, action: 'skipped-real', detail: `${p} is the profile's own, so the shared ${child} is not linked` })
    }
  }

  results.push({ entry: MERGED_ENTRY, action: 'merged', detail: `${ownEntries(dest, src).length} of its own, ${shared.length} shared` })
  return results
}

/** Entries in a profile's agents directory that are not ccprovider's links to the
 *  shared ones. */
function ownEntries(dest: string, src: string): string[] {
  return readdirSync(dest).filter((child) => !isSharedLink(join(dest, child), src))
}

function isSharedLink(p: string, src: string): boolean {
  if (!lstatSafe(p)?.isSymbolicLink()) return false
  return dirname(readlinkSync(p)) === src
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
export function inspectLinks(dir: string): Array<{ entry: string; target: string | null; broken: boolean; merged?: boolean }> {
  return LINKED_ENTRIES.map((entry) => {
    const p = join(dir, entry)
    const st = lstatSafe(p)
    if (!st) return { entry, target: null, broken: false }
    // The profile's own agents beside per-file links to the shared ones: intended.
    if (entry === MERGED_ENTRY && st.isDirectory()) return { entry, target: '(own agents + shared links)', broken: false, merged: true }
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
