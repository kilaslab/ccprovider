import { readdirSync } from 'node:fs'
import { join } from 'node:path'

import { profileDir } from '../paths.js'
import { loadStore, getProfile } from '../profile.js'
import { reconcileLinks } from '../configdir.js'
import { loadSettings, sharesSessions } from '../settings.js'
import { AGENT_CATALOG, AGENT_SOURCE, installAgents, listInstalled, readExplore, removeAgents, setExplore, syncAgents, type AgentResult } from '../agents.js'
import type { Profile } from '../types.js'
import { c, requireName, type Paths, agentLine } from '../ui.js'

const AGENT_SUBCOMMANDS = ['ls', 'list', 'add', 'rm', 'remove', 'explore']

/** `ccprovider agents [ls|add|rm|explore] <name> …` — a bare `agents <name>` lists. */
export async function cmdAgents(paths: Paths, args: string[], yes: boolean): Promise<number> {
  const [sub, rawName, ...rest] = AGENT_SUBCOMMANDS.includes(args[0] ?? '') ? args : ['ls', ...args]
  const name = requireName(rawName, `agents ${sub}`)
  const profile = getProfile(loadStore(paths), name)
  const shared = sharesSessions(profile, loadSettings(paths))
  // Listing is harmless; changing anything is not — a shared profile has no agents of its own.
  if (shared && sub !== 'ls' && sub !== 'list') {
    console.error(c.yellow(`"${name}" shares its config directory with ~/.claude, so it has no agents of its own. Run \`ccprovider settings\` (or \`ccprovider settings set shareSessions false ${name}\`) first.`))
    return 1
  }
  const dir = profileDir(paths, name)
  // The shared dir is the symlink source itself; linking it to itself is not a thing.
  if (!shared) reconcileLinks(dir, paths.claudeDir)

  let results: AgentResult[]
  switch (sub) {
    case 'add': {
      const ids = rest
      if (!ids.length) {
        if (!process.stdin.isTTY) {
          console.error(`Name the agents to add: ${AGENT_CATALOG.map((a) => a.id).join(', ')}`)
          return 1
        }
        const { chooseAgents } = await import('../tui/wizard.js')
        const installed = listInstalled(dir).filter((a) => a.known).map((a) => a.id)
        // The list starts from what is installed, so unticking one here removes it.
        results = await syncAgents(dir, paths.claudeDir, await chooseAgents(installed.length ? installed : null), { cacheDir: paths.cacheDir })
        break
      }
      results = await installAgents(dir, paths.claudeDir, ids, { cacheDir: paths.cacheDir })
      break
    }
    case 'rm': case 'remove':
      if (!rest.length) { console.error(`\`ccprovider agents rm ${name}\` needs the agents to remove.`); return 1 }
      results = removeAgents(dir, rest, { force: yes })
      break
    case 'explore': {
      const model = rest[0]
      if (!model) { console.error(`\`ccprovider agents explore ${name}\` needs a model: haiku, sonnet, opus, a model ID, or default.`); return 1 }
      try {
        results = [setExplore(dir, paths.claudeDir, model === 'default' ? null : model)]
      } catch (e) {
        console.error((e as Error).message)
        return 1
      }
      break
    }
    default:
      printAgents(paths, name, profile, dir)
      return 0
  }

  if (!shared) reconcileLinks(dir, paths.claudeDir)
  for (const r of results) console.log(agentLine(r))
  return results.some((r) => r.action === 'failed') ? 1 : 0
}

function printAgents(paths: Paths, name: string, profile: Profile, dir: string): void {
  const installed = new Map(listInstalled(dir).map((a) => [a.id, a]))
  console.log(`${c.bold(name)} agents  ${c.dim(`from ${AGENT_SOURCE.repo} @ ${AGENT_SOURCE.commit.slice(0, 7)}, MIT`)}`)
  for (const a of AGENT_CATALOG) {
    const got = installed.get(a.id)
    const mark = !got ? c.dim('·') : got.modified ? c.yellow('!') : c.green('✓')
    console.log(`  ${mark} ${a.id.padEnd(24)}${c.dim(got?.modified ? 'edited since it was installed' : a.summary)}`)
  }
  for (const a of installed.values()) {
    if (!a.known) console.log(`  ${c.yellow('!')} ${a.id.padEnd(24)}${c.dim('no longer in the catalog')}`)
  }

  const explore = readExplore(dir)
  const mapped = explore ? profile.aliases[explore.model as keyof Profile['aliases']] : undefined
  console.log(
    `  Explore  ${explore ? `${explore.model}${mapped ? ` → ${mapped}` : ''}${explore.modified ? c.yellow('  (edited)') : ''}` : c.dim('built-in, on the session model')}`,
  )
  let shared = 0
  try { shared = readdirSync(join(paths.claudeDir, 'agents')).length } catch { /* none */ }
  if (shared) console.log(c.dim(`  + ${shared} shared from ${join(paths.claudeDir, 'agents')}`))
  console.log(c.dim(`  ccprovider agents add|rm ${name} <id> · ccprovider agents explore ${name} <haiku|sonnet|opus|default>`))
}
