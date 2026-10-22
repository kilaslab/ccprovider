import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { dirname, join, relative } from 'node:path'
import type { Paths } from './paths.js'
import { ProfileError } from './profile.js'

/**
 * Token usage per profile, read from the transcripts Claude Code keeps in each profile's
 * own `projects/` directory, not from a proxy: nothing sits in the request path.
 *
 * What the transcripts turned out to be, measured on real ones, and so what this does:
 *
 * - One API call is written as several lines, snapshots of the same message. On a GLM
 *   profile 2,700 assistant lines were 1,250 message ids, and the early snapshots read
 *   0 input and 0 output; on Anthropic's, output_tokens grows from line to line. So lines
 *   are grouped by `message.id` and the largest value of each field is kept. Taking the
 *   first line, the usual shortcut, undercounts what the model wrote.
 * - Subagents write their own transcripts, deeper in the tree, and were most of the calls.
 * - A provider may leave the cache fields out. That is recorded as unknown (null), not 0.
 * - The files are large (gigabytes), so a ledger remembers how far into each one it has
 *   read, and a pass over unchanged files reads nothing.
 */

/** [model, first seen (epoch s), input, output, cache read, cache write]. Null: the
 *  provider did not say. */
export type CallRecord = [model: string, firstSeen: number, input: number, output: number, cacheRead: number | null, cacheWrite: number | null]

export interface FileState {
  /** How many bytes of the transcript are already counted: always up to a line break. */
  offset: number
  /** Fingerprint of its first line, to tell the same transcript from one written over it. */
  head?: string
  /** Fingerprint of the last bytes before `offset`: a transcript rewound and grown past its old
   *  size keeps its head and may still have a line break at the old offset, but not these bytes. */
  tail?: string
  /** Lines in it that looked like a call and could not be used. Missing calls, for good. */
  bad?: number
}

export interface Ledger {
  version: 1
  /** Per transcript, relative to `projects/`. */
  files: Record<string, FileState>
  calls: Record<string, CallRecord>
}

/** Every line that looked like a call and could not be counted, over the whole history of
 *  the ledger: a pass that reads nothing new must not report "none". */
export const unreadableTotal = (ledger: Ledger): number => Object.values(ledger.files).reduce((n, f) => n + (f.bad ?? 0), 0)

export const emptyLedger = (): Ledger => ({ version: 1, files: {}, calls: {} })

/** Where a profile's ledger lives. The profile name is already validated as a file name. */
export const ledgerPath = (paths: Paths, name: string): string => join(paths.usageDir, `${name}.json`)

/** The ledger for a shared config directory — everything that ran in it, the ccprovider
 *  profiles that share it and the plain `claude` alike, since transcripts never name a
 *  profile. Keyed by the directory, in a subdirectory of its own so the name can never
 *  collide with a profile's ledger: `ledgerFiles` lists flat `<name>.json*` files, so
 *  `rm` and `rename` never touch this one — other profiles may still share the directory. */
export const sharedLedgerPath = (paths: Paths, dir: string): string =>
  join(paths.usageDir, 'shared', `${createHash('sha256').update(dir).digest('hex').slice(0, 16)}.json`)

/** The ledger, the copy `--rebuild` leaves of the one it replaced, and the one set aside when
 *  it could not be read. They hold the same history, so they go wherever the profile goes. */
export function ledgerFiles(paths: Paths, name: string): string[] {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // Also what an interrupted write leaves: `<name>.json.<pid>.<hex>.tmp`, see saveLedger.
  const mine = new RegExp(`^${escaped}\\.json(\\.bak|\\.damaged(\\.\\d+)?|\\.\\d+\\.[0-9a-f]+\\.tmp)?$`)
  try {
    return readdirSync(paths.usageDir).filter((f) => mine.test(f)).sort().map((f) => join(paths.usageDir, f))
  } catch {
    return []
  }
}

export interface Note {
  /** Worth the user's attention, not just an account of what was done. */
  warn: boolean
  text: string
}

/** The ledger to scan into, and what had to be done to get it. The rules that guard history
 *  that transcripts can no longer give back live here, where they can be tested:
 *
 *  - A ledger that cannot be read (damaged, or from a newer ccprovider) is never written over.
 *    It is kept as `.damaged`, or `.damaged.2` and so on: a name once used is never reused.
 *  - `--rebuild` forgets the ledger, so the one it replaces is kept as `.bak`. A second rebuild
 *    would copy the already-shrunk ledger over the only copy that still holds the history, so
 *    the backup that holds more calls stays. */
export function prepareLedger(paths: Paths, name: string, opts: { rebuild: boolean }, path: string = ledgerPath(paths, name)): { ledger: Ledger; notes: Note[]; readOnly: boolean } {
  const notes: Note[] = []
  const existing = existsSync(path) ? loadLedger(path) : undefined // null: there, and not readable

  // Not damaged: newer. Putting an empty version-1 ledger over it would take the history from
  // the very ccprovider that wrote it, once Claude Code has pruned the transcripts. It is left
  // exactly as it is, and this run reports what the transcripts still hold without saving.
  if (existing === null && isNewer(path)) {
    notes.push({
      warn: true,
      text: `The usage ledger for "${name}" is from a newer ccprovider. It is left untouched; this report is built from the transcripts that still exist and is not saved. Update ccprovider to read it.`,
    })
    return { ledger: emptyLedger(), notes, readOnly: true }
  }
  if (existing === null) {
    let aside = `${path}.damaged`
    for (let n = 2; existsSync(aside); n++) aside = `${path}.damaged.${n}`
    copyFileSync(path, aside)
    chmodSync(aside, 0o600)
    // The unreadable file is replaced now that a copy is safe. Left in place it would be set
    // aside again on every run, for good, when no transcript is left to scan into it.
    saveLedger(path, emptyLedger())
    notes.push({ warn: true, text: `The usage ledger for "${name}" could not be read (damaged, or from a newer ccprovider). It is kept as ${aside}; reading the transcripts afresh.` })
  }

  if (opts.rebuild && existing) {
    const backup = `${path}.bak`
    const held = (l: Ledger | null | undefined) => (l ? Object.keys(l.calls).length : -1)
    if (held(existing) >= held(existsSync(backup) ? loadLedger(backup) : undefined)) {
      copyFileSync(path, backup)
      chmodSync(backup, 0o600)
      notes.push({ warn: false, text: `The previous ledger is kept as ${backup}` })
    } else {
      notes.push({ warn: false, text: `${backup} holds more history than the ledger being replaced, so it was left as it is.` })
    }
  }

  return { ledger: opts.rebuild ? emptyLedger() : (existing ?? emptyLedger()), notes, readOnly: false }
}

/** A well-formed ledger of a version this code does not know. */
function isNewer(path: string): boolean {
  try {
    const v = (JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown }).version
    return typeof v === 'number' && v > 1
  } catch {
    return false
  }
}

/** Read a ledger, or null if there is none worth keeping: absent, damaged, or written by a
 *  version of this code that this one does not know. The caller then reads from scratch. */
export function loadLedger(path: string): Ledger | null {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const l = raw as Partial<Ledger>
  if (l.version !== 1 || typeof l.files !== 'object' || l.files === null || typeof l.calls !== 'object' || l.calls === null) return null
  // Every entry, not only the outline: a hand-edited or half-written one would otherwise get
  // past here and crash every later run, instead of taking the set-aside path.
  if (!Object.values(l.files).every(isFileState) || !Object.values(l.calls).every(isCall)) return null
  return l as Ledger
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
const isFileState = (v: unknown): boolean => {
  if (typeof v !== 'object' || v === null) return false
  const f = v as Record<string, unknown>
  return isCount(f.offset) && (f.head === undefined || typeof f.head === 'string') && (f.tail === undefined || typeof f.tail === 'string') && (f.bad === undefined || isCount(f.bad))
}
const isCall = (v: unknown): boolean =>
  Array.isArray(v) &&
  v.length === 6 &&
  typeof v[0] === 'string' &&
  isCount(v[1]) && isCount(v[2]) && isCount(v[3]) &&
  (v[4] === null || isCount(v[4])) &&
  (v[5] === null || isCount(v[5]))

/** Write-then-rename, like the profile config: an interrupted write must not leave a
 *  truncated ledger. Private to the user, since it records when and how much they used. */
export function saveLedger(path: string, ledger: Ledger): void {
  // The directory is private too: its file names and times say when and how much was worked.
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(ledger), { mode: 0o600 })
    renameSync(tmp, path)
  } catch (e) {
    rmSync(tmp, { force: true }) // no half-written file left to accumulate
    throw e
  }
}

export interface ScanResult {
  filesRead: number
  /** Bytes taken from disk this pass. */
  bytesRead: number
  /** Lines that looked like an API call and could not be used. */
  unreadableLines: number
  /** Transcripts that could not be opened (deleted or locked while the pass ran). Nothing is
   *  recorded for them, so the next pass tries them again. */
  skippedFiles: number
}

export interface ScanOptions {
  /** Called as bytes are read, with the total this pass expects. */
  onProgress?: (done: number, total: number) => void
  /** Called between files, once this many bytes have been read since the last call, so a
   *  caller can save the ledger and an interrupted scan keeps what it has done. */
  onCheckpoint?: () => void
  checkpointBytes?: number
}

const CHUNK = 1 << 20

/** A message id is only ever a key. Providers spell them as they like, so nothing but a sane
 *  length is asked of one. */
const MAX_ID_LENGTH = 512

/** Count every call in a profile's transcripts that the ledger has not counted yet. Safe to
 *  run again, to stop half way, and to run over a file that is still being written. */
export async function scanProfile(profileDir: string, ledger: Ledger, opts: ScanOptions = {}): Promise<ScanResult> {
  const root = join(profileDir, 'projects')
  const result: ScanResult = { filesRead: 0, bytesRead: 0, unreadableLines: 0, skippedFiles: 0 }

  const work: Array<Transcript & { start: number; prev?: FileState }> = []
  for (const f of listTranscripts(root)) {
    const prev = Object.hasOwn(ledger.files, f.rel) ? ledger.files[f.rel] : undefined
    const known = prev?.offset ?? 0
    // A transcript only grows, so what was counted is where reading resumes. Anything else,
    // shorter, or no longer on a line break there, or opening with another line, was written
    // over: read it again. Merging by id makes reading twice safe; skipping would undercount.
    let start = known
    if (f.size < known) {
      // Written over, shorter. Forget where it was: if it ends up empty it is not read, and a
      // position left behind would be resumed in the middle once it grows back.
      start = 0
      delete ledger.files[f.rel]
    } else if (known > 0 && f.size > known) {
      try {
        if (!(await sameTranscript(f.abs, prev!))) start = 0
      } catch {
        result.skippedFiles++ // gone or locked since the walk
        continue
      }
    }
    if (start < f.size) work.push({ ...f, start, ...(prev ? { prev } : {}) })
  }
  const total = work.reduce((n, f) => n + (f.size - f.start), 0)

  let sinceCheckpoint = 0
  for (const f of work) {
    const unreadableBefore = result.unreadableLines
    let consumed: number
    let head: string | undefined
    let tail: string | undefined
    try {
      ;({ consumed, head, tail } = await readLines(f.abs, f.start, f.mtime, ledger, result, (n) => {
        result.bytesRead += n
        opts.onProgress?.(result.bytesRead, total)
      }))
    } catch {
      // Calls already merged from it are real and stay. No offset is stored, so the next
      // pass reads it again, and merging by id makes that safe.
      result.skippedFiles++
      continue
    }
    const bad = (f.start === 0 ? 0 : (f.prev?.bad ?? 0)) + (result.unreadableLines - unreadableBefore)
    ledger.files[f.rel] = { offset: f.start + consumed, ...(head ? { head } : {}), ...(tail ? { tail } : {}), ...(bad ? { bad } : {}) }
    result.filesRead++

    sinceCheckpoint += f.size - f.start
    if (opts.onCheckpoint && sinceCheckpoint >= (opts.checkpointBytes ?? 128 * CHUNK)) {
      opts.onCheckpoint()
      sinceCheckpoint = 0
    }
  }
  return result
}

/** Is this still the transcript the ledger read: the byte before the stored offset is a line
 *  break, and the first line is the one it began with. */
async function sameTranscript(path: string, prev: FileState): Promise<boolean> {
  const fh = await open(path, 'r')
  try {
    const one = Buffer.alloc(1)
    const { bytesRead } = await fh.read(one, 0, 1, prev.offset - 1)
    if (bytesRead !== 1 || one[0] !== 0x0a) return false
    // A ledger from before fingerprints existed has only the line break to go on.
    if (prev.head !== undefined && (await fingerprint(fh)) !== prev.head) return false
    return prev.tail === undefined || (await tailPrint(fh, prev.offset)) === prev.tail
  } finally {
    await fh.close()
  }
}

const FINGERPRINT_BYTES = 64 * 1024
const TAIL_BYTES = 256

/** A short hash of the bytes just before `end`. */
async function tailPrint(fh: FileHandle, end: number): Promise<string | undefined> {
  const length = Math.min(TAIL_BYTES, end)
  if (length <= 0) return undefined
  const buf = Buffer.alloc(length)
  const { bytesRead } = await fh.read(buf, 0, length, end - length)
  return bytesRead === length ? createHash('sha256').update(buf).digest('hex').slice(0, 16) : undefined
}

/** A short hash of how the file begins, which stays the same while it grows: its first line,
 *  or, for a first line longer than 64 KiB, the first 64 KiB of it. Undefined while the file
 *  has neither a complete line nor that much yet. */
async function fingerprint(fh: FileHandle): Promise<string | undefined> {
  const buf = Buffer.alloc(FINGERPRINT_BYTES)
  const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
  const end = buf.subarray(0, bytesRead).indexOf(0x0a)
  const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex').slice(0, 16)
  if (end !== -1) return hash(buf.subarray(0, end))
  return bytesRead === buf.length ? hash(buf) : undefined
}

interface Transcript {
  rel: string
  abs: string
  size: number
  mtime: number
}

/** Every `.jsonl` under `root`, at any depth, in a stable order. Symlinks are not followed. */
function listTranscripts(root: string): Transcript[] {
  const found: Transcript[] = []
  const walk = (dir: string) => {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names.sort()) {
      const abs = join(dir, name)
      let st
      try {
        st = lstatSync(abs)
      } catch {
        continue
      }
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) walk(abs)
      else if (st.isFile() && name.endsWith('.jsonl')) found.push({ rel: relative(root, abs), abs, size: st.size, mtime: Math.floor(st.mtimeMs / 1000) })
    }
  }
  walk(root)
  return found
}

/** Feed the complete lines of one file, from `start`, into the ledger. Returns how many
 *  bytes were consumed: everything up to the last newline, because the last line may be
 *  half written, and reading half of it would lose the call for good. */
async function readLines(
  path: string,
  start: number,
  fallbackTs: number,
  ledger: Ledger,
  result: ScanResult,
  progress: (bytes: number) => void,
): Promise<{ consumed: number; head: string | undefined; tail: string | undefined }> {
  const fh = await open(path, 'r')
  try {
    const chunk = Buffer.allocUnsafe(CHUNK)
    // The unfinished last line, as the pieces read so far. A line of tens of megabytes is
    // joined once, when its end arrives, not again on every read.
    let pending: Buffer[] = []
    let pendingBytes = 0
    let consumed = 0
    for (;;) {
      const { bytesRead } = await fh.read(chunk, 0, CHUNK, start + consumed + pendingBytes)
      if (bytesRead === 0) break
      progress(bytesRead)
      const piece = Buffer.from(chunk.subarray(0, bytesRead))
      const lastNewline = piece.lastIndexOf(0x0a)
      if (lastNewline === -1) {
        pending.push(piece)
        pendingBytes += bytesRead
        continue
      }
      const complete = Buffer.concat([...pending, piece.subarray(0, lastNewline)])
      for (const line of complete.toString('utf8').split('\n')) ingest(ledger, line, fallbackTs, result)
      consumed += pendingBytes + lastNewline + 1
      const rest = Buffer.from(piece.subarray(lastNewline + 1))
      pending = rest.length ? [rest] : []
      pendingBytes = rest.length
    }
    const end = start + consumed
    return { consumed, head: end > 0 ? await fingerprint(fh) : undefined, tail: end > 0 ? await tailPrint(fh, end) : undefined }
  } finally {
    await fh.close()
  }
}

const count = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)
const maxOf = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.max(a, b))

function ingest(ledger: Ledger, line: string, fallbackTs: number, result: ScanResult): void {
  // The cheap test first: most lines are not assistant turns, and parsing them is the cost.
  // `"usage"` with its closing quote only appears as a key: inside a string it is escaped.
  if (!line.includes('"usage"') || !line.includes('"assistant"')) return

  let entry: { type?: unknown; timestamp?: unknown; message?: { id?: unknown; model?: unknown; usage?: Record<string, unknown> } }
  try {
    entry = JSON.parse(line)
  } catch {
    result.unreadableLines++
    return
  }
  const m = entry.message
  if (entry.type !== 'assistant' || !m || typeof m.id !== 'string') return
  // A call whose id cannot be filed is one that cannot be counted: say so, don't drop it unseen.
  if (!m.id || m.id.length > MAX_ID_LENGTH) {
    result.unreadableLines++
    return
  }
  // `<synthetic>` is Claude Code speaking for itself (an interrupt, an error), not a call.
  if (typeof m.model !== 'string' || !m.model || m.model === '<synthetic>') return
  const u = m.usage
  if (typeof u !== 'object' || u === null) return

  const at = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN
  const ts = Number.isNaN(at) ? fallbackTs : Math.floor(at / 1000)
  const input = count(u.input_tokens) ?? 0
  const output = count(u.output_tokens) ?? 0
  const cacheRead = count(u.cache_read_input_tokens)
  const cacheWrite = count(u.cache_creation_input_tokens)

  // Own properties only: `constructor` and `toString` are valid ids, and a plain object
  // answers to them with what it inherits.
  const seen = Object.hasOwn(ledger.calls, m.id) ? ledger.calls[m.id] : undefined
  if (!seen) {
    // defineProperty and not assignment: `ledger.calls['__proto__'] = x` would replace the
    // object's prototype instead of filing a call.
    Object.defineProperty(ledger.calls, m.id, {
      value: [m.model, ts, input, output, cacheRead, cacheWrite],
      writable: true,
      enumerable: true,
      configurable: true,
    })
    return
  }
  seen[1] = Math.min(seen[1], ts)
  seen[2] = Math.max(seen[2], input)
  seen[3] = Math.max(seen[3], output)
  seen[4] = maxOf(seen[4], cacheRead)
  seen[5] = maxOf(seen[5], cacheWrite)
}

export interface UsageRow {
  profile: string
  model: string
  day?: string
  calls: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** The provider reported cache on at least one of these calls. When false the zeros mean
   *  "unknown", and a hit rate would be made up. */
  cacheReported: boolean
}

/** Whole percent done, never past 100: the total is fixed when a pass starts, and a transcript
 *  that grows meanwhile is read past it. */
export const progressPercent = (done: number, total: number): number => (total <= 0 ? 100 : Math.min(100, Math.round((done / total) * 100)))

export interface AggregateOptions {
  /** Epoch seconds: only calls first seen at or after this. */
  since?: number
  by?: 'day'
  /** Injectable so a test does not depend on the time zone it runs in. */
  dayOf?: (epochSeconds: number) => string
}

const localDay = (s: number): string => {
  const d = new Date(s * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Sum the ledgers into rows. Pure; the profile order is the order of `ledgers`. */
export function aggregate(ledgers: Record<string, Ledger>, opts: AggregateOptions): UsageRow[] {
  const dayOf = opts.dayOf ?? localDay
  const out: UsageRow[] = []
  for (const [profile, ledger] of Object.entries(ledgers)) {
    const rows = new Map<string, UsageRow>()
    for (const [model, ts, input, output, cacheRead, cacheWrite] of Object.values(ledger.calls)) {
      if (opts.since !== undefined && ts < opts.since) continue
      const day = opts.by === 'day' ? dayOf(ts) : undefined
      const key = `${day ?? ''}\0${model}`
      let row = rows.get(key)
      if (!row) {
        row = { profile, model, ...(day !== undefined ? { day } : {}), calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheReported: false }
        rows.set(key, row)
      }
      row.calls++
      row.input += input
      row.output += output
      row.cacheRead += cacheRead ?? 0
      row.cacheWrite += cacheWrite ?? 0
      if (cacheRead !== null || cacheWrite !== null) row.cacheReported = true
    }
    out.push(...[...rows.values()].sort((a, b) => (a.day ?? '').localeCompare(b.day ?? '') || a.model.localeCompare(b.model)))
  }
  return out
}

/** `7d` (that many days back) or `2026-10-01` (that day, local midnight), as epoch seconds. */
export function parseSince(value: string, now = Date.now() / 1000): number {
  const days = /^(\d+)d$/.exec(value)
  if (days && Number(days[1]) > 0) return now - Number(days[1]) * 86400

  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (date) {
    const [y, m, d] = [Number(date[1]), Number(date[2]), Number(date[3])]
    const at = new Date(y, m - 1, d)
    // new Date rolls 2026-13-40 over into a real day; a round trip tells them apart.
    if (at.getFullYear() === y && at.getMonth() === m - 1 && at.getDate() === d) return at.getTime() / 1000
  }
  throw new ProfileError(`--since takes a number of days back (7d) or a date (2026-10-01), not "${value}".`)
}


/** 1,250,000 → 1.3M. Exact figures are what `--json` is for. */
function compact(n: number): string {
  if (n < 1000) return String(n)
  const units: Array<[number, string]> = [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']]
  for (let i = 0; i < units.length; i++) {
    const [size, suffix] = units[i]!
    if (n < size) continue
    const text = (n / size).toFixed(1)
    // 999,950 rounds to "1000.0K": say 1.0M instead.
    if (text === '1000.0' && i > 0) return `1.0${units[i - 1]![1]}`
    return `${text}${suffix}`
  }
  return String(n)
}

/** cache read / (input + cache read + cache write), over the rows that reported cache. */
const hitRate = (rows: UsageRow[]): string => {
  const reported = rows.filter((r) => r.cacheReported)
  const read = sum(reported, 'cacheRead')
  const total = sum(reported, 'input') + read + sum(reported, 'cacheWrite')
  return total > 0 ? `${Math.round((read / total) * 100)}%` : '—'
}

export function renderUsage(rows: UsageRow[], opts: { subscription: Set<string>; color: boolean }): string {
  if (!rows.length) return 'No usage recorded yet.'
  // Colour only when asked: to a file or a pager the codes are noise.
  const dim = (s: string) => (opts.color ? `\x1b[2m${s}\x1b[0m` : s)
  const bold = (s: string) => (opts.color ? `\x1b[1m${s}\x1b[0m` : s)

  const lines: string[] = []
  const profiles = [...new Set(rows.map((r) => r.profile))]
  const withDay = rows.some((r) => r.day !== undefined)

  // A profile that is a Claude subscription now may have been a provider before: `add --default`
  // keeps the slot's directory, so its transcripts and its ledger go on across the change. Its
  // rows are told apart by model, because the label says who bills them. A heuristic, and it
  // has a hole: a provider can answer under a Claude name (docs/usage.md: Z.ai does), and those
  // calls land under "Claude subscription". The other direction is certain — a subscription only
  // produces Claude models, so any other model in it came from an earlier provider. A provider
  // profile's rows stay as they are, unlabelled.
  const isClaudeModel = (model: string) => /^claude-/i.test(model)
  const groups: Array<{ profile: string; mine: UsageRow[]; note: string }> = []
  for (const profile of profiles) {
    const all = rows.filter((r) => r.profile === profile)
    if (!opts.subscription.has(profile)) {
      groups.push({ profile, mine: all, note: '' })
      continue
    }
    const claude = all.filter((r) => isClaudeModel(r.model))
    const other = all.filter((r) => !isClaudeModel(r.model))
    if (claude.length) groups.push({ profile, mine: claude, note: '  Claude subscription' })
    if (other.length) groups.push({ profile, mine: other, note: '  not Claude models — from an earlier provider' })
  }

  for (const { profile, mine, note } of groups) {
    // What each printed line is, and which rows its hit rate is taken over.
    const entries: Array<{ row: UsageRow; of: UsageRow[]; total: boolean }> = mine.map((row) => ({ row, of: [row], total: false }))
    if (mine.length > 1 && !withDay) {
      const row: UsageRow = {
        profile,
        model: 'total',
        calls: sum(mine, 'calls'),
        input: sum(mine, 'input'),
        output: sum(mine, 'output'),
        cacheRead: sum(mine, 'cacheRead'),
        cacheWrite: sum(mine, 'cacheWrite'),
        cacheReported: mine.some((r) => r.cacheReported),
      }
      entries.push({ row, of: mine, total: true })
    }

    const header = ['model', 'calls', 'input', 'output', 'cache read', 'cache write', 'cache hit']
    const body = entries.map(({ row: r, of }) => [
      r.model,
      String(r.calls),
      compact(r.input),
      compact(r.output),
      r.cacheReported ? compact(r.cacheRead) : '—',
      r.cacheReported ? compact(r.cacheWrite) : '—',
      hitRate(of),
    ])
    if (withDay) {
      header.unshift('day')
      body.forEach((cells, i) => cells.unshift(entries[i]!.row.day ?? ''))
    }

    const widths = header.map((h, i) => Math.max(h.length, ...body.map((cells) => cells[i]!.length)))
    // Text columns on the left, figures on the right.
    const textCols = withDay ? 2 : 1
    const fmt = (cells: string[]) => cells.map((c, i) => (i < textCols ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join('  ')

    lines.push(`${bold(profile)}${note ? dim(note) : ''}`)
    lines.push(dim(`  ${fmt(header)}`))
    body.forEach((cells, i) => lines.push(`  ${entries[i]!.total ? dim(fmt(cells)) : fmt(cells)}`))
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}

const sum = (rows: UsageRow[], key: 'calls' | 'input' | 'output' | 'cacheRead' | 'cacheWrite') => rows.reduce((n, r) => n + r[key], 0)
