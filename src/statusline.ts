import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { isInside, type Paths } from './paths.js'
import { ProfileError } from './profile.js'
import { findOnPath, isDefaultWrapper, isExecutable, isLauncher } from './shim.js'

/**
 * The token badge in Claude Code's footer, from cc-token-statusline (MIT, Alfafis).
 *
 * Not written here and not copied in: ccprovider pins one upstream commit with a hash per
 * file, downloads those files once, checks every hash, and runs the upstream installer. The
 * installer already does what is hard to do right (backs up settings.json, chains onto a
 * status line you already have, undoes itself), so none of it is redone. And what runs on
 * every render of the footer is exactly the code that was read when the pin was set.
 *
 * `statusLine` lives in settings.json, which every profile links to. So one install covers
 * them all, and it must go into the real config directory: a profile's directory would put
 * that profile's path into a file all the others read.
 */

export interface SourceSpec {
  repo: string
  commit: string
  version: string
  files: ReadonlyArray<{ path: string; sha256: string }>
}

/** Hashes of the files at the pinned commit, taken on 2026-10-17 from raw.githubusercontent.com.
 *  Moving the pin means re-reading the files and re-taking every hash; with
 *  `CCPROVIDER_NETWORK_TESTS=1` the tests check them all against GitHub. */
export const STATUSLINE_SOURCE: SourceSpec = {
  repo: 'Alfafis/cc-token-statusline',
  commit: '24bf9174df544ef9642e09b21619d10f222977ba',
  version: '0.4.5',
  files: [
    { path: 'scripts/install.py', sha256: '31c36c26629fca7b936caea7c568f2882db01a96c8714eb4e2e47f7a928dff4e' },
    { path: 'scripts/tokens_statusline.py', sha256: 'a20fdd8b2f31658fd2f36ecfa226f2603b380366ac493c3241a7b3a6e02d7e91' },
    { path: 'scripts/statusline_chain.py', sha256: '5e22df32b170d94c40cc0da4f335d5cbf9edc50d172ff682c3243161428a1a7f' },
    { path: '.claude-plugin/plugin.json', sha256: 'bf8eb2e947e0609073fea65a23d435c839f2d5d6b6aa4ffa58bfbdadbaaa8786' },
    { path: 'LICENSE', sha256: '58b96799d280a012cd5b4b6ac7efa06670d71ae2da43ac5236c68a509f62f9fe' },
  ],
}

const FETCH_TIMEOUT = 15_000
const BADGE_NAMES = /tokens_statusline\.py|statusline_chain\.py|tokens-statusline\.sh/
/** The badge's files by name. A word is the badge when a path in it ends in one of these, so
 *  `my_tokens_statusline.py` and `tokens_statusline.py.bak` are not it. */
const BADGE_FILES = new Set(['tokens_statusline.py', 'statusline_chain.py', 'tokens-statusline.sh'])
const namesBadge = (word: string): boolean => word.split(/\s+/).some((t) => BADGE_FILES.has(basename(t)))
const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex')

export type StatuslineState =
  | { state: 'absent' }
  | { state: 'foreign'; command: string }
  | {
      state: 'ours'
      command: string
      /** Another status line is wrapped, and the badge is appended to its output. */
      chained: boolean
      /** The status line is a script of the user's that calls the badge among other things, and
       *  upstream leaves it as it is. */
      combined?: boolean
      version?: string
      /** Set when the script lives inside a profile's directory (this is that directory's
       *  `hooks`): a profile's directory is not where the footer of every profile should depend
       *  on, since removing the profile would hide the status bar in all of them. */
      misplaced?: string
      /** The interpreter and the script the command names both exist. A command that fails
       *  hides the whole status bar, other badges included. */
      working: boolean
    }

function readJson(path: string): Record<string, unknown> {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8'))
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Words of a command, double-quoted, single-quoted or bare. */
const words = (command: string) => [...command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => (m[1] ?? m[2] ?? m[3])!)

/** `~` and `$VAR` / `${VAR}` the way the shell that runs the command will see them. A variable
 *  that is not set is left as written, which then fails to exist, honestly. */
function expandVars(word: string, vars: Record<string, string | undefined>): string {
  const home = vars.HOME
  const tilde = home ? word.replace(/^~(?=\/|$)/, home) : word
  // `${NAME}`, `$NAME` and `${NAME:-default}`, where a variable that is unset or empty gives the default.
  return tilde.replace(/\$\{(\w+)(?::-([^}]*))?\}|\$(\w+)/g, (match, a: string | undefined, fallback: string | undefined, b: string | undefined) => {
    const value = vars[(a ?? b)!]
    if (fallback !== undefined) return value ? value : fallback
    return value ?? match
  })
}

/** Order two dotted versions as numbers. Anything that is not a version is older than any. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] | null => (/^\d+(\.\d+)*$/.test(v) ? v.split('.').map(Number) : null)
  const [pa, pb] = [parse(a), parse(b)]
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/** What the real config directory's settings.json says about the status line. */
export function inspectStatusline(
  claudeDir: string,
  env: Record<string, string | undefined> = process.env,
  /** Where the profiles live; without it a misplaced script cannot be told. */
  dirsRoot?: string,
): StatuslineState {
  const sl = readJson(join(claudeDir, 'settings.json')).statusLine
  const command = typeof sl === 'object' && sl !== null ? (sl as { command?: unknown }).command : undefined
  if (typeof command !== 'string' || !command) return { state: 'absent' }

  // CLAUDE_CONFIG_DIR is taken as it stands, not made up: in a profile's session it is that
  // profile's directory, which has no hooks/, and a footer that works from ~/.claude and
  // hides the status bar everywhere else must not be reported as healthy.
  const parts = words(command).map((w) => expandVars(w, env))
  if (!parts.some(namesBadge)) {
    // Not named, but a script of the user's may still run it. Upstream looks inside the files
    // the command names; so does this, for the same reason: counting it as somebody else's
    // would offer the footer for ever.
    // Not the first word of a longer command: that is the interpreter, and a binary is no script.
    const combiner = parts.slice(parts.length > 1 ? 1 : 0).find((w) => callsBadge(w))
    const version = combiner ? stampOf(claudeDir) : undefined
    return combiner
      ? { state: 'ours', command, chained: false, combined: true, ...(version ? { version } : {}), working: true }
      : { state: 'foreign', command }
  }

  // `python3 "<script>"`, or, in older versions, the script alone as the whole command.
  // A word that is a file is the script, with its spaces. Failing that, the command may wrap
  // one (`sh -c "python3 <script>"`), and the words inside the quotes are tried one by one.
  const named = parts.filter(namesBadge)
  const script =
    named.find((w) => existsSync(w)) ??
    named.flatMap((w) => w.split(/\s+/)).find((t) => BADGE_FILES.has(basename(t)) && existsSync(t)) ??
    named[0]
  const at = script === undefined ? -1 : parts.findIndex((w) => w === script)
  const interpreter = at > 0 || (at === -1 && script !== undefined) ? parts[0] : undefined
  const resolved = interpreter && !interpreter.includes('/') ? findOnPath(interpreter, env.PATH) : interpreter
  const runs = interpreter === undefined ? !!script && isExecutable(script) : !!resolved && isExecutable(resolved)
  const stamp = stampOf(claudeDir)
  const chained = command.includes('statusline_chain.py')
  return {
    state: 'ours',
    command,
    chained,
    ...(stamp ? { version: stamp } : {}),
    ...(script && dirsRoot && isInside(script, dirsRoot) ? { misplaced: dirname(script) } : {}),
    // The wrapper runs the badge after the status line it wraps: without the badge it has none to run.
    working: runs && !!script && existsSync(script) && (!chained || existsSync(join(claudeDir, 'hooks', 'tokens_statusline.py'))),
  }
}

const MAX_SCRIPT_BYTES = 256 * 1024

/** Is this word a file, small enough to be a script, that mentions the badge. */
function callsBadge(word: string): boolean {
  try {
    const st = statSync(word)
    return st.isFile() && st.size <= MAX_SCRIPT_BYTES && BADGE_NAMES.test(readFileSync(word, 'utf8'))
  } catch {
    return false
  }
}

/** The version the installer stamped next to its copy of the badge. */
function stampOf(claudeDir: string): string | undefined {
  const v = readJson(join(claudeDir, 'hooks', 'cc-token-statusline-installed.json')).version
  return typeof v === 'string' ? v : undefined
}

function matches(dir: string, source: SourceSpec): boolean {
  return source.files.every((f) => {
    try {
      return sha256(readFileSync(join(dir, f.path))) === f.sha256
    } catch {
      return false
    }
  })
}

/** The Claude plugin's own copy, when it is byte for byte the pinned one. Saves a download
 *  and keeps the plugin's session hook from seeing two versions of the badge. */
export function findLocalSource(claudeDir: string, source: SourceSpec = STATUSLINE_SOURCE): string | null {
  const cache = join(claudeDir, 'plugins', 'cache')
  const dirs = (p: string) => {
    try {
      return readdirSync(p)
    } catch {
      return []
    }
  }
  for (const marketplace of dirs(cache)) {
    for (const version of dirs(join(cache, marketplace, 'token-status-line'))) {
      const dir = join(cache, marketplace, 'token-status-line', version)
      if (matches(dir, source)) return dir
    }
  }
  return null
}

export interface StatuslineDeps {
  paths: Paths
  source?: SourceSpec
  fetchImpl?: typeof fetch
  /** Where to look for python, and what the installer inherits. */
  env?: Record<string, string | undefined>
  /** How long the installer may run. */
  timeoutMs?: number
}

export interface Source {
  dir: string
  from: 'plugin' | 'cache' | 'download'
}

/** A directory holding the pinned files, every one of them hash-checked. */
export async function ensureSource(deps: StatuslineDeps): Promise<Source> {
  const { paths } = deps
  const source = deps.source ?? STATUSLINE_SOURCE

  const local = findLocalSource(paths.claudeDir, source)
  if (local) return { dir: local, from: 'plugin' }

  const dir = join(paths.cacheDir, 'statusline', source.commit)
  if (matches(dir, source)) return { dir, from: 'cache' }

  // Everything is fetched and checked before anything is written: a file that does not match
  // leaves no half a copy behind to be trusted later.
  // Together, so a link that GitHub cannot be reached over costs one timeout and not five.
  const got: Array<[string, Buffer]> = await Promise.all(
    source.files.map(async (f): Promise<[string, Buffer]> => {
      const url = `https://raw.githubusercontent.com/${source.repo}/${source.commit}/${f.path}`
      const res = await (deps.fetchImpl ?? fetch)(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) })
      if (!res.ok) throw new ProfileError(`HTTP ${res.status} fetching ${url}`)
      const body = Buffer.from(await res.arrayBuffer())
      if (sha256(body) !== f.sha256) {
        throw new ProfileError(`the file at ${url} does not match its pinned sha256, so it was not installed`)
      }
      return [f.path, body]
    }),
  )

  const staging = `${dir}.${randomBytes(4).toString('hex')}.tmp`
  try {
    for (const [path, body] of got) {
      mkdirSync(dirname(join(staging, path)), { recursive: true })
      writeFileSync(join(staging, path), body)
    }
    rmSync(dir, { recursive: true, force: true }) // an old copy that no longer matches
    renameSync(staging, dir)
    return { dir, from: 'download' }
  } catch (e) {
    // Two runs downloading at once: the other may have put the same, verified copy there first.
    if (matches(dir, source)) return { dir, from: 'cache' }
    throw e
  } finally {
    rmSync(staging, { recursive: true, force: true }) // nothing half written stays in the cache
  }
}

interface RunResult {
  status: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

/** A python that actually runs. Being an executable file named python3 is not enough: on a Mac
 *  without the Command Line Tools, /usr/bin/python3 is a stub that raises an install dialog
 *  and runs nothing. */
function usablePython(env: Record<string, string | undefined>): string {
  let broken: string | undefined
  for (const name of ['python3', 'python']) {
    // Not a launcher ccprovider wrote under that name: it would be started with `-c` and run
    // as Claude Code. The names are reserved now, but one may have been installed before.
    const found = findOnPath(name, env.PATH, [], (p) => isLauncher(p) || isDefaultWrapper(p))
    if (!found) continue
    const probe = spawnSync(found, ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)'], {
      stdio: 'ignore',
      timeout: 5_000,
      env: { PATH: env.PATH ?? '', HOME: env.HOME ?? '' },
    })
    if (probe.status === 0) return found
    broken ??= found
  }
  throw new ProfileError(
    broken
      ? `The token status line needs Python 3.8 or newer, and ${broken} does not run it. ` +
          'On a Mac without the Command Line Tools /usr/bin/python3 is only a stub: `xcode-select --install` installs the real one.'
      : 'The token status line needs python3 (3.8 or newer) on your PATH, and there is none.',
  )
}

/** Run the upstream installer against the real config directory. Not given the whole
 *  environment: it needs a PATH, a home and where to work, and holds no business with an API
 *  key that happens to be exported. */
function runInstaller(deps: StatuslineDeps, dir: string, args: string[], python: string): RunResult {
  const env = deps.env ?? process.env

  const keep = (k: string): [string, string][] => (env[k] ? [[k, env[k]!]] : [])
  const r = spawnSync(python, [join(dir, 'scripts', 'install.py'), ...args], {
    encoding: 'utf8',
    timeout: deps.timeoutMs ?? 60_000,
    env: {
      ...Object.fromEntries(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR'].flatMap(keep)),
      CLAUDE_CONFIG_DIR: deps.paths.claudeDir,
    },
  })
  return {
    status: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr || r.error?.message || '',
    timedOut: (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT',
  }
}

function check(r: RunResult, timeoutMs: number): void {
  if (r.timedOut) throw new ProfileError(`The token status line installer timed out after ${Math.round(timeoutMs / 1000)}s.`)
  if (r.status === 0) return
  const said = (r.stderr || r.stdout).trim().split('\n').slice(-6).join('\n')
  throw new ProfileError(`The token status line installer failed (exit ${r.status ?? 'none'}):\n${said}`)
}

const lines = (text: string) => text.split('\n').map((l) => l.trimEnd()).filter(Boolean)

export interface AddResult {
  /** `combined`: the status line in use already runs the badge, so the installer refreshed
   *  the badge's copy and left `statusLine` as it was. */
  action: 'installed' | 'already' | 'combined'
  /** Another status line is now wrapped, with the badge after it. */
  chained: boolean
  from?: Source['from']
  /** What the installer printed, for showing. */
  output: string[]
}

export async function addStatusline(deps: StatuslineDeps): Promise<AddResult> {
  const source = deps.source ?? STATUSLINE_SOURCE
  const before = inspectStatusline(deps.paths.claudeDir, deps.env, deps.paths.dirsRoot)
  // A newer badge than the pinned one (the Claude plugin's own hook can install one) is left
  // alone: putting the pinned files over it would be a downgrade the plugin then undoes.
  if (before.state === 'ours' && before.working && !before.misplaced && before.version !== undefined && compareVersions(before.version, source.version) >= 0) {
    return { action: 'already', chained: before.chained, output: [] }
  }

  // Before the download: five requests to learn that what they were for cannot run is the
  // wrong order, and offline the user would be told about the network instead of the blocker.
  const python = usablePython(deps.env ?? process.env)
  const src = await sourceOrExplain(
    deps,
    'The token footer needs its files once, from GitHub or from the Claude plugin of the same name. Try again when you are online.',
  )
  const r = runInstaller(deps, src.dir, [], python)
  check(r, deps.timeoutMs ?? 60_000)

  const after = inspectStatusline(deps.paths.claudeDir, deps.env, deps.paths.dirsRoot)
  if (after.state !== 'ours' || !after.working) {
    throw new ProfileError(`The installer finished, but the status line is not wired up: ${lines(r.stdout).join('; ')}`)
  }
  clearDeclined(deps.paths)
  // A status line that already runs the badge is done as far as upstream is concerned: it
  // refreshes the copy and leaves statusLine alone.
  return { action: after.combined ? 'combined' : 'installed', chained: after.chained, from: src.from, output: lines(r.stdout) }
}

export interface RemoveResult {
  /** `combined`: the status line is the user's own script, which ccprovider does not edit. */
  action: 'removed' | 'not-installed' | 'combined'
  output: string[]
}

/** Undo it with the installer's own `--uninstall`, which puts back a status line it had
 *  wrapped. A status line that is not the badge is not touched. */
export async function removeStatusline(deps: StatuslineDeps): Promise<RemoveResult> {
  const state = inspectStatusline(deps.paths.claudeDir, deps.env)
  if (state.state !== 'ours') return { action: 'not-installed', output: [] }
  // The user's own script runs the badge and statusLine is theirs: the installer's --uninstall
  // leaves it alone, so there is nothing to undo here, and no "no" to remember.
  if (state.combined) return { action: 'combined', output: [] }
  const settings = join(deps.paths.claudeDir, 'settings.json')
  const python = usablePython(deps.env ?? process.env)
  const src = await sourceOrExplain(
    deps,
    `Removing it needs the installer's files once. Offline, take it out by hand: delete the "statusLine" key from ${settings} (the installer left a backup next to it, settings.json.bak.*).`,
  )
  const r = runInstaller(deps, src.dir, ['--uninstall'], python)
  check(r, deps.timeoutMs ?? 60_000)
  // Taking it off is an answer: `add` should not offer it again as if it had never been asked.
  declineStatusline(deps.paths)
  return { action: 'removed', output: lines(r.stdout) }
}

/** `ensureSource`, with what to do about a failure that is the network's. A file that does
 *  not match its hash is not that, and is reported as it is. */
async function sourceOrExplain(deps: StatuslineDeps, advice: string): Promise<Source> {
  try {
    return await ensureSource(deps)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    if (/does not match its pinned sha256/.test(message)) throw e
    throw new ProfileError(`${message}\n${advice}`, { cause: e })
  }
}

// ---- the offer made by `ccprovider add`

export type OfferAnswer = 'yes' | 'no' | 'cancel'

export type OfferOutcome =
  | { outcome: 'not-needed' }
  | { outcome: 'declined' }
  | { outcome: 'cancelled' }
  | { outcome: 'installed'; chained: boolean; combined: boolean }
  | { outcome: 'failed'; error: string }

/** Offer the footer when it is missing or broken. The decisions live here so they are tested;
 *  `ask` is the prompt. A "no" is remembered, so it is asked once. Cancelling the prompt is
 *  not an answer and is not remembered. A footer that stopped working is raised again whatever
 *  was said before, since a failing status line command hides the whole status bar. */
export async function runOffer(
  deps: StatuslineDeps,
  ask: (ctx: { broken: boolean; foreign: boolean }) => Promise<OfferAnswer>,
): Promise<OfferOutcome> {
  const s = inspectStatusline(deps.paths.claudeDir, deps.env)
  const broken = s.state === 'ours' && !s.working
  if (s.state === 'ours' && !broken) return { outcome: 'not-needed' }
  if (!broken && statuslineDeclined(deps.paths)) return { outcome: 'not-needed' }

  const answer = await ask({ broken, foreign: s.state === 'foreign' })
  if (answer === 'cancel') return { outcome: 'cancelled' }
  if (answer === 'no') {
    declineStatusline(deps.paths)
    return { outcome: 'declined' }
  }
  try {
    const r = await addStatusline(deps)
    return { outcome: 'installed', chained: r.chained, combined: r.action === 'combined' }
  } catch (e) {
    return { outcome: 'failed', error: e instanceof Error ? e.message : String(e) }
  }
}

// ---- being asked once

const declinedFile = (paths: Paths) => join(dirname(paths.configFile), 'statusline-declined')

/** `add` offers the footer once. A "no" is remembered so it does not ask on every profile.
 *  Only a convenience: when it cannot be written the offer is simply made again, which must
 *  not turn into an error in the middle of adding a profile. */
export function declineStatusline(paths: Paths): void {
  try {
    mkdirSync(dirname(paths.configFile), { recursive: true })
    writeFileSync(declinedFile(paths), 'declined\n')
  } catch {
    // see above
  }
}

export const statuslineDeclined = (paths: Paths): boolean => existsSync(declinedFile(paths))

function clearDeclined(paths: Paths): void {
  try {
    rmSync(declinedFile(paths), { force: true })
  } catch {
    // see declineStatusline
  }
}
