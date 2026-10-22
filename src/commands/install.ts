import { loadStore, getProfile } from '../profile.js'
import { type Paths, installCommand } from '../ui.js'
import { pathHint } from '../pathhint.js'

export async function cmdInstall(paths: Paths, name: string | undefined): Promise<number> {
  const store = loadStore(paths)
  if (name) getProfile(store, name)
  const names = name ? [name] : Object.keys(store.providers)
  if (!names.length) { console.log('No profiles yet. Run `ccprovider add`.'); return 0 }

  let failed = false
  for (const n of names) {
    const r = installCommand(paths, n, { automatic: false })
    console.log(r.line)
    if (!r.ok) failed = true
  }
  for (const line of pathHint(paths)) console.log(line)
  return failed ? 1 : 0
}
