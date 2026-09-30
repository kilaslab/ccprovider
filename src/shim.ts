import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, delimiter, join, resolve } from 'node:path'
import type { Paths } from './paths.js'
import { ProfileError, validateName } from './profile.js'
import { shellQuote } from './shell.js'

/**
 * A "shim" is the tiny script that makes profile `glm` runnable as the command `glm`.
 *
 * It holds no secret and no configuration: it only re-enters `ccprovider use glm`,
 * which is the one place that reads the key and builds the environment. Anything
 * smarter belongs there, not in a file sitting in a PATH directory.
 */

/** Commands a shim may never take: every program ccprovider itself resolves through
 *  PATH. A launcher with one of these names would be found first, run `ccprovider use`,
 *  which looks the program up again — and the launcher would call itself forever. */
const RESERVED: Record<string, string> = {
  claude: 'it would shadow Claude Code itself, and `ccprovider use` finds `claude` on PATH, so the launcher would call itself forever',
  ccprovider: 'it would shadow this tool',
  which: '`ccprovider use` runs `which claude`, so the launcher would call itself forever',
  security: 'ccprovider stores keys through the macOS `security` command',
  'secret-tool': 'ccprovider stores keys through the Linux `secret-tool` command',
  node: '`ccprovider doctor` probes the `node` on PATH',
  npx: 'MCP servers are started with the `npx` on PATH',
}

const SHEBANG = '#!/bin/sh'
const NODE_GUARD = '[ -x '
const MARKER_RE = /^# ccprovider-shim profile=([a-z0-9][a-z0-9._-]{0,63}) /

/** Longest file we will even read when deciding whether a file is one of ours. A real
 *  shim is ~200 bytes; anything bigger is somebody else's binary. */
const MAX_SHIM_BYTES = 4096

export interface ShimInfo {
  /** Command name — the file's name in binDir. */
  command: string
  /** Profile the marker line names. */
  profile: string
  path: string
  /** The program (and leading args) the shim execs before `use <profile> --`. */
  launcher: string[]
  /** The `node` the shim tries first, when it has one — see `preferredNode`. */
  node?: string
}

/** Validate a name for use as a command. `validateName` alone is not enough: it must
 *  keep accepting every profile that already exists, so the command-specific rules
 *  live here and apply only at install time. */
export function commandName(name: string): string {
  const cmd = validateName(name)
  const why = RESERVED[cmd]
  if (why) throw new ProfileError(`"${cmd}" cannot be installed as a command: ${why}.`)
  return cmd
}

/** How to re-run this same ccprovider.
 *
 *  Installed from npm, or built from a clone, the entry is a JavaScript file whose
 *  shebang finds `node` on PATH when it runs. The launcher bakes that *file* and not the
 *  interpreter, on purpose: under nvm or fnm `process.execPath` is a versioned path that
 *  vanishes the day the user changes Node version, and every launcher would go with it.
 *
 *  (The launcher still tries that interpreter first while it exists — see `preferredNode`.)
 *
 *  From TypeScript source (`bun run src/cli.ts`) there is no shebang to lean on, so the
 *  runtime that is running is part of the launcher. */
export function selfLauncher(execPath = process.execPath, argv1: string | undefined = process.argv[1]): string[] {
  if (!argv1) throw new ProfileError('Cannot tell how ccprovider was started, so a launcher cannot point at it.')
  const script = realpathSync(argv1)
  return /\.[cm]?js$/.test(script) ? [script] : [execPath, script]
}

/** The `node` a launcher should try before falling back on the entry's shebang.
 *
 *  The shebang is `#!/usr/bin/env node`, which takes whichever `node` comes first on PATH —
 *  and that is not always Node. direnv's `PATH_add .bin` is a common way for a project to
 *  put a `node` wrapper in front (one that runs `docker compose exec app node`), and from
 *  inside that project every launcher would then start ccprovider in a container.
 *
 *  So the launcher tries the `node` that is installing it first, and only when that file
 *  is gone — the nvm/fnm version change `selfLauncher` is careful about — does it fall
 *  back on the shebang. Only a lone JavaScript entry has a shebang to fall back on, and
 *  only an interpreter that is actually `node` is worth pinning. */
export function preferredNode(launcher: string[], execPath = process.execPath): string | undefined {
  const [entry, ...rest] = launcher
  if (!entry || rest.length || !/\.[cm]?js$/.test(entry)) return undefined
  return basename(execPath) === 'node' ? execPath : undefined
}

/** Every value goes through `shellQuote`, so nothing in a path or name can be parsed
 *  as shell syntax. `"$@"` is the one intentionally live expansion. */
export function renderShim(launcher: string[], name: string, node?: string): string {
  if (!launcher.length) throw new ProfileError('Cannot write a launcher with nothing to run.')
  // The exec line is parsed back one line at a time. A path with a line break would
  // write a file this tool then cannot recognise as its own — unmanageable, not unsafe.
  if ([...launcher, node ?? ''].some((w) => /[\r\n]/.test(w))) {
    throw new ProfileError('ccprovider is installed at a path containing a line break; a launcher cannot point at it.')
  }
  // `--` is not optional: ccprovider's own parser would otherwise claim -m, -h and
  // -y from the user's arguments instead of handing them to claude.
  const tail = `use ${shellQuote(name)} -- "$@"`
  const exec = `exec ${launcher.map(shellQuote).join(' ')} ${tail}`
  return [
    SHEBANG,
    `# ccprovider-shim profile=${name} - managed by ccprovider, do not edit`,
    // When `node` is missing, `[ -x ]` fails, `&&` skips the exec and the next line runs.
    ...(node ? [`[ -x ${shellQuote(node)} ] && exec ${[node, ...launcher].map(shellQuote).join(' ')} ${tail}`] : []),
    exec,
    '',
  ].join('\n')
}

/** Read `path` as a shim, or return null if it is anything else.
 *
 *  This is the ownership test that gates every overwrite and delete. It is strict on
 *  purpose: a symlink is never ours (`~/.local/bin/claude` is one), and a file must be
 *  small, start with our shebang, and carry our marker on line 2. */
function readShim(path: string): ShimInfo | null {
  let st
  try {
    st = lstatSync(path)
  } catch {
    return null
  }
  if (!st.isFile() || st.size > MAX_SHIM_BYTES) return null

  const text = readText(path)
  if (text === null) return null

  const [line1, line2, line3, line4] = text.split('\n')
  if (line1 !== SHEBANG) return null
  const marker = MARKER_RE.exec(line2 ?? '')
  if (!marker) return null

  // Launchers written before `preferredNode` existed have no guard line.
  const guarded = line3?.startsWith(NODE_GUARD) ?? false
  const execLine = guarded ? line4 : line3
  if (!execLine?.startsWith('exec ')) return null

  // The last word is the profile; the rest is the launcher.
  const words = quotedWords(execLine)
  if (words.length < 2) return null
  const node = guarded ? quotedWords(line3!)[0] : undefined
  if (guarded && !node) return null

  const profile = marker[1]!
  return { command: path.split('/').pop()!, profile, path, launcher: words.slice(0, -1), ...(node ? { node } : {}) }
}

/** Our own quoting is the only quoting present: single-quoted words, with a literal
 *  quote spelled '\''. */
function quotedWords(line: string): string[] {
  return [...line.matchAll(/'((?:[^']|'\\'')*)'/g)].map((m) => m[1]!.replace(/'\\''/g, "'"))
}

export type InstallAction = 'created' | 'updated' | 'unchanged'

/**
 * Write the launcher for `name` into binDir.
 *
 * Refuses to touch a file it did not create. That is the whole safety story: binDir is
 * the user's own PATH directory and may hold real programs (`kimi`, `claude`) under the
 * very names a profile might pick.
 */
export function installShim(
  paths: Paths,
  name: string,
  launcher: string[],
  node = preferredNode(launcher),
): { path: string; action: InstallAction } {
  const cmd = commandName(name)
  const path = join(paths.binDir, cmd)
  const body = renderShim(launcher, cmd, node)
  mkdirSync(paths.binDir, { recursive: true })

  const foreign = () =>
    new ProfileError(
      `${path} already exists and was not created by ccprovider, so it was left alone. ` +
        `Move it aside, or rename the profile (\`ccprovider rename ${cmd} <new name>\`), then run \`ccprovider install ${cmd}\`.`,
    )

  // Unpredictable, and opened O_EXCL below: a predictable name written with the default
  // flags would follow a symlink someone planted there and overwrite whatever it points at.
  const tmp = join(paths.binDir, `.${cmd}.ccprovider-${randomBytes(6).toString('hex')}.tmp`)
  const stage = () => {
    writeFileSync(tmp, body, { flag: 'wx', mode: 0o755 })
    chmodSync(tmp, 0o755) // the umask may have trimmed the mode above
  }
  try {
    if (lstatSafe(path)) {
      const ours = readShim(path)
      if (!ours || ours.profile !== cmd) throw foreign()
      if (readText(path) === body) {
        chmodSync(path, 0o755)
        return { path, action: 'unchanged' }
      }
      stage()
      renameSync(tmp, path)
      return { path, action: 'updated' }
    }

    stage()
    // link(2) fails if `path` exists, unlike rename(2), which silently replaces it. A
    // stat-then-rename would leave a window in which a file created by someone else
    // gets overwritten; this closes it.
    try {
      linkSync(tmp, path)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'EEXIST') throw foreign()
      // Some filesystems (FUSE and network mounts, exFAT) have no hard links. O_EXCL on
      // the real name gives the same no-clobber guarantee, just without the atomic
      // appearance of a complete file.
      if (code === 'EPERM' || code === 'ENOSYS' || code === 'ENOTSUP' || code === 'EXDEV') {
        try {
          writeFileSync(path, body, { flag: 'wx', mode: 0o755 })
          chmodSync(path, 0o755)
        } catch (w) {
          if ((w as NodeJS.ErrnoException).code === 'EEXIST') throw foreign()
          throw w
        }
      } else {
        throw e
      }
    }
    return { path, action: 'created' }
  } finally {
    try {
      unlinkSync(tmp)
    } catch {
      // already renamed away, or never written
    }
  }
}

export interface InstallReport {
  ok: boolean
  /** Typing the name in a shell now runs this profile. Not implied by `ok`: the directory
   *  may be off PATH, or another program of that name may come first. */
  usable: boolean
  path?: string
  action?: InstallAction
  /** A real program elsewhere on PATH that this launcher now stands in front of. */
  shadows?: string
  /** A PATH entry that is consulted before binDir and answers to the same name. */
  shadowedBy?: string
  /** Why nothing was installed. */
  error?: string
}

/**
 * Install the launcher for a profile, deciding what is safe to do on the user's behalf.
 * Never throws: the profile is already saved by the time this runs, so *any* failure —
 * ours or the filesystem's (EACCES, a read-only mount) — is a report, not a crash.
 *
 * `automatic` is `add`'s unprompted install. Taking a name that a real program already
 * answers to (`gemini`, `qwen`) would silently turn that program into Claude Code, so an
 * automatic install steps aside; asking for it by name is taken as intent, and the
 * report says what it now stands in front of.
 */
export function installCommandFor(
  paths: Paths,
  name: string,
  launcher: () => string[],
  opts: { automatic: boolean; env?: Record<string, string | undefined> },
): InstallReport {
  const env = opts.env ?? process.env
  try {
    const cmd = commandName(name)
    const other = findOtherProgram(cmd, paths.binDir, env.PATH)
    if (other && opts.automatic) {
      return {
        ok: false,
        usable: false,
        error:
          `another program called ${cmd} is already on your PATH (${other}), and a launcher would replace it. ` +
          `Run \`ccprovider install ${cmd}\` if that is what you want.`,
      }
    }
    const r = installShim(paths, cmd, launcher())
    const s = inspectShim(paths, cmd, env)
    return {
      ok: true,
      usable: s.binDirOnPath && !s.shadowedBy,
      path: r.path,
      action: r.action,
      shadows: other,
      shadowedBy: s.shadowedBy,
    }
  } catch (e) {
    return { ok: false, usable: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export type RemoveResult = 'removed' | 'absent' | 'foreign'

/** Delete the launcher for `name` if — and only if — ccprovider wrote it. Works for
 *  orphans too: it needs only the file, not a profile. */
export function removeShim(paths: Paths, name: string): RemoveResult {
  const cmd = validateName(name)
  const path = join(paths.binDir, cmd)
  if (!lstatSafe(path)) return 'absent'
  const ours = readShim(path)
  if (!ours || ours.profile !== cmd) return 'foreign'
  unlinkSync(path)
  return 'removed'
}

/** Every launcher in binDir that ccprovider wrote *and* can manage: the file's name must
 *  be the profile its marker names. A copy (`cp glm glm.bak`) or a renamed file still
 *  carries a marker, but `removeShim` rightly refuses it, so listing it would promise
 *  removals that cannot happen. */
export function listShims(paths: Paths): ShimInfo[] {
  let entries: string[]
  try {
    entries = readdirSync(paths.binDir)
  } catch {
    return []
  }
  const out: ShimInfo[] = []
  for (const entry of entries) {
    if (entry.startsWith('.')) continue
    const s = readShim(join(paths.binDir, entry))
    if (s && s.command === s.profile) out.push(s)
  }
  return out
}

export interface ShimStatus {
  path: string
  /** `foreign`: something else occupies the name. */
  state: 'absent' | 'foreign' | 'ours'
  launcher?: string[]
  /** The launcher's program exists and can be run. */
  targetOk?: boolean
  binDirOnPath: boolean
  /** An earlier PATH entry that would answer to this command first. */
  shadowedBy?: string
}

export function inspectShim(paths: Paths, name: string, env: Record<string, string | undefined> = process.env): ShimStatus {
  const cmd = validateName(name)
  const path = join(paths.binDir, cmd)
  const base = { path, binDirOnPath: binDirOnPath(paths.binDir, env.PATH), shadowedBy: findShadow(cmd, paths.binDir, env.PATH) }
  if (!lstatSafe(path)) return { ...base, state: 'absent' }
  const ours = readShim(path)
  if (!ours || ours.profile !== cmd) return { ...base, state: 'foreign' }
  const [program, ...rest] = ours.launcher
  return { ...base, state: 'ours', launcher: ours.launcher, targetOk: isExecutable(program!) && rest.every((p) => existsSync(p)) }
}

export function binDirOnPath(binDir: string, pathVar: string | undefined): boolean {
  return pathEntries(pathVar).some((d) => samePath(d, binDir))
}

/** The first PATH entry *before* binDir that holds an executable called `cmd`.
 *
 *  If binDir is not on PATH at all, whatever answers to `cmd` today is what the user
 *  will actually get, so that is reported too. */
export function findShadow(cmd: string, binDir: string, pathVar: string | undefined): string | undefined {
  for (const dir of pathEntries(pathVar)) {
    if (samePath(dir, binDir)) return undefined
    const candidate = join(dir, cmd)
    if (isExecutable(candidate)) return candidate
  }
  return undefined
}

/** An executable called `cmd` in any PATH directory other than binDir — i.e. a real
 *  program that a launcher of that name would replace for anyone who has binDir first. */
export function findOtherProgram(cmd: string, binDir: string, pathVar: string | undefined): string | undefined {
  for (const dir of pathEntries(pathVar)) {
    if (samePath(dir, binDir)) continue
    const candidate = join(dir, cmd)
    if (isExecutable(candidate)) return candidate
  }
  return undefined
}

function pathEntries(pathVar: string | undefined): string[] {
  return (pathVar ?? '').split(delimiter).filter(Boolean)
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    try {
      return realpathSync(p)
    } catch {
      return resolve(p)
    }
  }
  return norm(a) === norm(b)
}

function isExecutable(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false
    accessSync(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function lstatSafe(p: string) {
  try {
    return lstatSync(p)
  } catch {
    return null
  }
}

function readText(p: string): string | null {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return null
  }
}
