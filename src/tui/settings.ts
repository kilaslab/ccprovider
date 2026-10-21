import { p } from './prompts.js'
import { loadStore, ProfileError } from '../profile.js'
import { applyGlobalShare, applyProfileShare, describeShare, loadSettings, type ShareChange } from '../settings.js'
import { isOauth } from '../types.js'
import type { Paths } from '../paths.js'

// Profile names start with a letter or digit (validateName), so these cannot collide with one.
const GLOBAL = ':global'
const DONE = ':done'

type ProfileChoice = 'inherit' | 'share' | 'own'

/**
 * `ccprovider settings` at a terminal: the global default and every profile in one list, each
 * showing what it resolves to, so nothing has to be remembered to change it.
 *
 * Every change is saved the moment it is made and the list is drawn again from disk, so what is
 * on screen is what is stored. Leaving is never a cancellation — there is nothing unsaved to lose.
 */
export async function runSettingsMenu(paths: Paths): Promise<number> {
  p.intro(`ccprovider settings  ${paths.settingsFile}`)

  let at: string = GLOBAL
  for (;;) {
    const store = loadStore(paths)
    const settings = loadSettings(paths)
    const entries = Object.entries(store.providers)
    const width = Math.max(0, ...entries.map(([n]) => n.length))
    const followers = entries.filter(([, pr]) => !isOauth(pr) && pr.shareSessions === undefined).map(([n]) => n)

    // The state is in the label and not a hint: clack shows a hint only for the row under the cursor.
    const picked = await p.select({
      message: 'Chat sessions shared with the plain claude — pick one to change',
      initialValue: at,
      options: [
        {
          value: GLOBAL,
          label: `Default for every profile   ${settings.shareSessions ? 'shared' : 'isolated'}${followers.length ? `  · followed by ${followers.join(', ')}` : ''}`,
        },
        ...entries.map(([n, pr]) => ({ value: n, label: `${n.padEnd(width)}   ${describeShare(pr, settings)}`, disabled: isOauth(pr) })),
        { value: DONE, label: 'Done' },
      ],
    })
    if (p.isCancel(picked) || picked === DONE) break
    at = picked

    try {
      if (picked === GLOBAL) {
        const answer = await p.confirm({
          message: 'Share chat sessions with the plain claude by default?  (profiles with their own setting keep it)',
          initialValue: settings.shareSessions,
        })
        if (!p.isCancel(answer) && answer !== settings.shareSessions) show(applyGlobalShare(paths, answer))
        continue
      }

      const pr = store.providers[picked]!
      const current: ProfileChoice = pr.shareSessions === undefined ? 'inherit' : pr.shareSessions ? 'share' : 'own'
      const choice = await p.select({
        message: `${picked}'s chat sessions`,
        initialValue: current,
        options: [
          { value: 'inherit', label: `Follow the default  (now: ${settings.shareSessions ? 'shared' : 'isolated'})` },
          { value: 'share', label: 'Share with ~/.claude', hint: 'claude --resume sees them' },
          { value: 'own', label: 'Keep its own', hint: 'isolated, whatever the default says' },
        ] satisfies Array<{ value: ProfileChoice; label: string; hint?: string }>,
      })
      if (!p.isCancel(choice) && choice !== current) {
        show(applyProfileShare(paths, picked, choice === 'inherit' ? undefined : choice === 'share'))
      }
    } catch (e) {
      // The profile went away, or the file changed under the menu: say so and draw the list again.
      if (!(e instanceof ProfileError)) throw e
      p.log.error(e.message)
    }
  }

  p.outro('Done.')
  return 0
}

function show(r: ShareChange): void {
  p.log.success(r.done)
  for (const note of r.notes) p.log.info(note)
}
