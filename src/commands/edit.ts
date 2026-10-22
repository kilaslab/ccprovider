import { loadStore, saveStore, getProfile } from '../profile.js'
import { loadSettings, sessionsStayNote, sharesSessions } from '../settings.js'
import { p } from '../tui/prompts.js'
import { isOauth } from '../types.js'
import { c, type Paths, type Secrets } from '../ui.js'
import { settleProfile } from '../setup.js'

export async function cmdEdit(paths: Paths, secrets: Secrets, name: string, refresh: boolean): Promise<number> {
  const store = loadStore(paths)
  const profile = getProfile(store, name)
  if (isOauth(profile)) {
    console.log(`"${name}" is a Claude subscription profile: there is no endpoint or key to edit. Use /login inside it to switch accounts.`)
    return 0
  }
  const apiKey = await secrets.get(name)
  const { runWizard } = await import('../tui/wizard.js')
  const result = await runWizard(paths, { name, profile, apiKey }, [], refresh)
  // Only `add` can be redirected to an edit; editing never asks for a name.
  if ('editInstead' in result) return 1
  const updated = result.profile
  const settings = loadSettings(paths)
  store.providers[name] = updated
  saveStore(paths, store)
  if (result.apiKey) await secrets.set(name, result.apiKey)
  const shared = sharesSessions(updated, settings)
  for (const line of await settleProfile(paths, name, updated, result, profile)) console.log(line)
  // Said once, here, because the sessions it already has are the surprise: they stay behind.
  if (shared && !sharesSessions(profile, settings)) console.log(c.dim(`  ${sessionsStayNote(paths, name)}`))
  p.outro('Updated.')
  return 0
}
