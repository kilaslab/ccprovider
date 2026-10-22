import { existsSync } from 'node:fs'

import { profileDir } from '../paths.js'
import { loadStore, getProfile, ProfileError } from '../profile.js'
import { loadSettings, sharesSessions } from '../settings.js'
import { DEFAULT_SLOT, loadSlot, type Epoch } from '../slot.js'
import { aggregate, ledgerPath, parseSince, prepareLedger, progressPercent, renderUsage, saveLedger, scanProfile, sharedLedgerPath, unreadableTotal, type Ledger } from '../usage.js'
import { p } from '../tui/prompts.js'
import { isClaude } from '../types.js'
import { c, type Paths } from '../ui.js'

interface UsageFlags {
  since?: string
  by?: string
  json: boolean
  rebuild: boolean
}

const mb = (bytes: number) => (bytes >= 1 << 30 ? `${(bytes / (1 << 30)).toFixed(1)} GB` : `${Math.round(bytes / (1 << 20))} MB`)

export async function cmdUsage(paths: Paths, name: string | undefined, flags: UsageFlags): Promise<number> {
  const store = loadStore(paths)
  if (name) getProfile(store, name)
  const names = name ? [name] : Object.keys(store.providers)
  if (!names.length) { console.log('No profiles yet. Run `ccprovider add`.'); return 0 }

  // Checked before reading gigabytes, not after.
  const since = flags.since === undefined ? undefined : parseSince(flags.since)
  if (flags.by !== undefined && flags.by !== 'day') throw new ProfileError(`--by takes "day", not "${flags.by}".`)

  // Only worth a progress line when there is a lot to read and a person watching.
  const watched = process.stdout.isTTY && !flags.json
  const ledgers: Record<string, Ledger> = {}
  let unreadable = 0
  let skipped = 0

  // One scan per profile of its own directory — a profile that shares keeps its older
  // sessions there — plus, when any selected profile shares, one scan of the real config
  // dir under the name `shared`. The trees are disjoint, so nothing is counted twice, and
  // the shared pass is never attributed to a profile: transcripts do not name one.
  const settings = loadSettings(paths)
  const scans: Array<{ label: string; dir: string; path: string }> = names.map((n) => ({ label: n, dir: profileDir(paths, n), path: ledgerPath(paths, n) }))
  // Called `shared` unless a profile already is, which would otherwise take its place in the report.
  const sharedLabel = names.includes('shared') ? 'shared (~/.claude)' : 'shared'
  if (names.some((n) => sharesSessions(store.providers[n]!, settings))) {
    scans.push({ label: sharedLabel, dir: paths.claudeDir, path: sharedLedgerPath(paths, paths.claudeDir) })
  }

  for (const scan of scans) {
    const path = scan.path
    // What guards the history in the ledger (set aside what cannot be read, keep the backup
    // that holds more) is decided in usage.ts, where it is tested.
    const { ledger, notes, readOnly } = prepareLedger(paths, scan.label, { rebuild: flags.rebuild }, path)
    for (const note of notes) console.error(note.warn ? c.yellow(`! ${note.text}`) : c.dim(note.text))
    const save = () => {
      if (readOnly) return // a ledger from a newer ccprovider is not ours to write
      // Also when no call was found: the positions in the transcripts that were read are worth keeping.
      if (Object.keys(ledger.files).length || Object.keys(ledger.calls).length || existsSync(path)) saveLedger(path, ledger)
    }

    const ui: { spin: ReturnType<typeof p.spinner> | null } = { spin: null }
    let lastTick = 0
    let r: Awaited<ReturnType<typeof scanProfile>> | undefined
    try {
      r = await scanProfile(scan.dir, ledger, {
        onProgress: (done, total) => {
          if (!watched || total < 32 << 20) return
          if (!ui.spin) { ui.spin = p.spinner(); ui.spin.start(`Reading ${scan.label}'s transcripts`) }
          const now = Date.now()
          if (now - lastTick < 200) return
          lastTick = now
          ui.spin.message(`Reading ${scan.label}'s transcripts: ${progressPercent(done, total)}% of ${mb(total)}`)
        },
        // A scan of gigabytes that is interrupted keeps what it has read.
        onCheckpoint: save,
      })
    } finally {
      // Also when the scan or a checkpoint throws: a spinner left running garbles the error.
      ui.spin?.stop(r ? `Read ${mb(r.bytesRead)} of ${scan.label}'s transcripts` : `Stopped reading ${scan.label}'s transcripts`)
    }
    if (r.filesRead > 0 || flags.rebuild) save()
    unreadable += unreadableTotal(ledger)
    skipped += r.skippedFiles
    ledgers[scan.label] = ledger
  }

  // The default may have been several providers over its life; the slot file says when.
  const epochs = loadSlotEpochs(paths)
  const rows = aggregate(ledgers, { since, by: flags.by === 'day' ? 'day' : undefined, epochs: { [DEFAULT_SLOT]: epochs } })
  if (flags.json) {
    console.log(JSON.stringify({ rows, unreadableLines: unreadable, skippedFiles: skipped }, null, 2))
    return 0
  }

  // Colour for a person at a terminal, not for a file or a pager, and not against NO_COLOR.
  const color = !!process.stdout.isTTY && !process.env.NO_COLOR
  const dim = (text: string) => (color ? c.dim(text) : text)
  const subscription = new Set(names.filter((n) => isClaude(store.providers[n]!)))
  console.log(renderUsage(rows, { subscription, color }))
  if (rows.length) {
    console.log(dim('\nFrom the transcripts Claude Code keeps in each profile, not the provider\'s bill. A dash means the provider did not report cache.'))
    if (ledgers.shared) {
      console.log(dim(`"${sharedLabel}" is everything that ran in ${paths.claudeDir}: the profiles that share it and the plain claude alike — a transcript never names the profile that wrote it.`))
    }
  }
  if (skipped) console.log(dim(`${skipped} transcript${skipped === 1 ? '' : 's'} could not be opened (deleted or locked meanwhile) and will be tried again next time.`))
  if (unreadable) console.log(dim(`${unreadable} line${unreadable === 1 ? '' : 's'} that looked like a call could not be read and were skipped.`))
  return 0
}

/** The default's history of providers, or none when it has no slot file or it cannot be read:
 *  usage must not fail over a file that only refines how its rows are labelled. */
function loadSlotEpochs(paths: Paths): Epoch[] {
  try {
    return loadSlot(paths).epochs
  } catch {
    return []
  }
}
