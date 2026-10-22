import { loadStore, saveStore, ProfileError } from '../profile.js'
import { loadSettings } from '../settings.js'
import { answersFromFlags, verifyProvider, type AddFlags } from '../addflags.js'
import { readSecretFromStdin } from '../stdin.js'
import type { EditInstead, WizardResult } from '../tui/wizard.js'
import { DEFAULT_SLOT, assertSlotWritable, saveDefaultSlot } from '../defaultslot.js'
import { removeProfile } from '../remove.js'
import { selfLauncher } from '../shim.js'
import { p } from '../tui/prompts.js'
import { isOauth, type Profile, type ProfileStore } from '../types.js'
import { c, type Paths, type Secrets, installCommand, loginHint, offerStatusline } from '../ui.js'
import { pathHint, offerDefaultPath } from '../pathhint.js'
import { settleProfile } from '../setup.js'
import { cmdEdit } from './edit.js'

export interface AddOptions {
  refresh: boolean
  install: boolean
  /** Offer the token footer. Never offered when the answers come from flags. */
  statusline: boolean
  /** Set when `--provider` was given: the answers come from here and nothing is asked. */
  flags: AddFlags | null
  yes: boolean
}

/** The answers for a new profile or the slot: asked for by the wizard, or taken from flags.
 *  A run from flags never prompts, so what the wizard would confirm is refused instead. */
async function obtainAnswers(paths: Paths, store: ProfileStore, opts: AddOptions, slot: boolean, current: Profile | undefined): Promise<WizardResult | EditInstead> {
  const takenNames = Object.keys(store.providers)
  if (!opts.flags) {
    const { runWizard } = await import('../tui/wizard.js')
    return runWizard(paths, null, takenNames, opts.refresh, slot ? { slot: true, current } : {})
  }
  if (slot && current && !opts.yes) {
    throw new ProfileError('This replaces the profile behind the default `claude`, and nothing is asked when the answers come from flags. Add -y to confirm.')
  }
  const answers = await answersFromFlags(opts.flags, { slot, takenNames, settings: loadSettings(paths), current, readKey: readSecretFromStdin })
  if (!opts.flags.noProbe) await verifyProvider(answers)
  return answers
}

export async function cmdAdd(paths: Paths, secrets: Secrets, opts: AddOptions): Promise<number> {
  const { refresh, install } = opts
  const store = loadStore(paths)
  const result = await obtainAnswers(paths, store, opts, false, undefined)
  if ('editInstead' in result) return cmdEdit(paths, secrets, result.editInstead, refresh)
  // Deleted only now that the new one is confirmed: cancelling anywhere before this
  // leaves the old profile exactly as it was.
  if (result.replace) {
    const r = await removeProfile({ paths, secrets, store }, result.name, { keepDefault: true })
    for (const w of r.warnings) console.error(c.yellow(`! ${w}`))
    console.log(c.dim(`Replaced the previous "${result.name}" profile, its session history and its usage record.`))
  }
  store.providers[result.name] = result.profile
  saveStore(paths, store)
  if (result.apiKey) await secrets.set(result.name, result.apiKey)

  for (const line of await settleProfile(paths, result.name, result.profile, result)) console.log(line)
  for (const line of opts.flags ? [] : await offerStatusline(paths, opts.statusline)) console.log(line)
  const installed = install ? installCommand(paths, result.name, { automatic: true }) : null
  if (installed) {
    console.log(installed.line)
    if (installed.ok) for (const line of pathHint(paths)) console.log(line)
  }
  // Only promise the short form when it will actually work: a command that was skipped,
  // is off PATH, or is shadowed would launch something else.
  const use = c.bold(`ccprovider use ${result.name}`)
  if (isOauth(result.profile)) console.log(loginHint(`"${result.name}"`))
  finish(opts,
    installed?.usable ? `Saved. Launch it with  ${c.bold(result.name)}  or  ${use}`
    : install ? `Saved. Launch it with  ${use}`
    : `Saved. Launch it with  ${use}   (\`ccprovider install ${result.name}\` makes it a command)`,
  )
  return 0
}

/** The closing line: clack's outro at a wizard, a plain line for a script. */
function finish(opts: AddOptions, message: string): void {
  if (opts.flags) console.log(message)
  else p.outro(message)
}

/** `add --default`: the one profile behind the plain `claude`, overwritten in place. Picking a
 *  new default replaces the old one instead of adding a profile, and the slot's directory (so
 *  its session history) is kept across the switch. */
export async function cmdAddDefault(paths: Paths, secrets: Secrets, opts: AddOptions): Promise<number> {
  const store = loadStore(paths)
  // Before the wizard, so a `claude` that is not ours does not cost a filled-in form.
  assertSlotWritable(paths)
  const current = Object.hasOwn(store.providers, DEFAULT_SLOT) ? store.providers[DEFAULT_SLOT] : undefined
  const result = await obtainAnswers(paths, store, opts, true, current)
  if ('editInstead' in result) return 1

  const saved = await saveDefaultSlot({ paths, secrets }, result.profile, result.apiKey, selfLauncher())
  for (const w of saved.warnings) console.error(c.yellow(`! ${w}`))
  for (const n of saved.notes) console.log(c.dim(`  ${n}`))

  for (const line of await settleProfile(paths, DEFAULT_SLOT, result.profile, result, current)) console.log(line)
  for (const line of opts.flags ? [] : await offerStatusline(paths, opts.statusline)) console.log(line)

  console.log(`${c.green('✓')} \`claude\` now runs the "${DEFAULT_SLOT}" profile  ${c.dim(saved.shim.path)}${saved.previous ? c.dim('  (replaced the previous default)') : ''}`)
  await offerDefaultPath(paths)
  if (isOauth(result.profile)) console.log(loginHint('the default'))
  finish(opts, 'Saved. Run  claude  from a new shell.')
  return 0
}
