import { profileDir } from './paths.js'
import { reconcileLinks } from './configdir.js'
import { loadSettings, sharesSessions } from './settings.js'
import { setExplore, syncAgents } from './agents.js'
import { findClaude } from './launch.js'
import { claudeRunner, readInstalledMcp, resolveServers, resolveUnwanted, syncMcp, type Desired, type Unwanted } from './mcp.js'
import { findPreset } from './presets.js'
import type { Profile } from './types.js'
import { c, type Paths, agentLine } from './ui.js'

/** What a profile had before it was saved again, so what the new answers switch off, or a
 *  different provider's servers, can be taken away. Absent fields mean "nothing before". */
export interface PreviousConfig {
  mcp?: string[]
  preset?: string
}

/**
 * Which MCP servers to register and which to take away. Pure, so the decisions can be tested
 * without a `claude` to run. `before` is what the profile had enabled before, so servers the
 * user just switched off can be removed. A profile that shares its config directory has nowhere
 * of its own to register servers, so it is planned with `removeOnly`: only a provider that was
 * switched away from loses its servers.
 */
export function planMcp(profile: Profile, before: PreviousConfig, removeOnly = false): { wanted: Desired[]; unwanted: Unwanted[] } {
  const previous = before.mcp ?? []
  const preset = profile.preset ? findPreset(profile.preset) : undefined
  const oldPresetId = before.preset ?? profile.preset
  const oldPreset = oldPresetId ? findPreset(oldPresetId) : undefined
  // The provider changed under a kept directory (`add --default`): everything the old one
  // registered goes, whatever the new profile enables, and it is recognised by the old preset's
  // definitions. Its helpers read this profile's key, which now belongs to someone else.
  const switched = oldPreset?.id !== preset?.id
  const enabled = preset?.mcp ? (profile.mcp ?? []) : []
  const resolved = preset?.mcp ? resolveServers(profile, preset) : null
  // A profile that shares has nowhere of its own to register servers, but a provider that
  // was switched away from must still lose its own: they are kept in a directory the profile
  // goes back to the day it stops sharing.
  const wanted = removeOnly ? [] : (resolved?.servers ?? [])

  // Servers to take away: those just switched off — and, when the endpoint is outside
  // every known region, everything enabled. A definition registered for the provider's
  // MCP host has a header helper that sends this profile's key there, which is right for
  // the provider's own endpoint and a leak for a gateway.
  const unwanted = removeOnly && !switched ? [] : [
    ...resolveUnwanted(switched ? previous : previous.filter((id) => !enabled.includes(id)), switched ? oldPreset : preset),
    ...(!removeOnly && resolved && !resolved.region ? resolveUnwanted(enabled, preset) : []),
  ]
  return { wanted, unwanted }
}

/** Bring the profile's Claude config in line with its enabled MCP servers (see `planMcp`).
 *  Like the command, this only ever warns. `resolveClaude` is where the `claude` binary comes
 *  from; tests give it a stand-in. */
export function setupMcp(
  paths: Paths,
  name: string,
  profile: Profile,
  before: PreviousConfig,
  removeOnly = false,
  resolveClaude: () => string = () => findClaude(process.env, [paths.defaultBinDir]),
): string[] {
  const { wanted, unwanted } = planMcp(profile, before, removeOnly)
  if (!wanted.length && !unwanted.length) return []

  const dir = profileDir(paths, name)
  let claude: string
  try {
    claude = resolveClaude()
  } catch (e) {
    return [c.yellow(`! MCP servers not set up: ${(e as Error).message}`), c.dim(`  Run \`ccprovider edit ${name}\` once claude is installed.`)]
  }

  const results = syncMcp({ run: claudeRunner(claude, dir), installed: readInstalledMcp(dir), wanted, unwanted })
  return results.map((r) =>
    r.action === 'failed' || r.action === 'kept'
      ? c.yellow(`! MCP ${r.id}: ${r.action}${r.detail ? ` — ${r.detail}` : ''}`)
      : `${c.green('✓')} MCP ${r.id} ${r.action}`,
  )
}

/** Bring the profile's agents and Explore override in line with the wizard's answer.
 *  Like MCP, a failure here only warns: the profile itself is already saved. Not for a profile
 *  that shares its config directory, which has no agents of its own: see `setupOwnConfig`. */
export async function setupAgents(paths: Paths, name: string, profile: Profile, wanted: string[], explore: string | null): Promise<string[]> {
  const dir = profileDir(paths, name)
  const results = [
    ...(await syncAgents(dir, paths.claudeDir, wanted, { cacheDir: paths.cacheDir })),
    setExplore(dir, paths.claudeDir, explore),
  ]
  // Back to the plain shared link when nothing of the profile's own is left.
  reconcileLinks(dir, paths.claudeDir)
  return results.filter((r) => r.action !== 'unchanged' && r.action !== 'absent').map(agentLine)
}

/** What `add` and `edit` set up inside the profile's own config directory: its MCP servers,
 *  agents and Explore model. A profile that shares runs in ~/.claude and has no directory of its
 *  own, so there is nothing to set up and the wizard did not ask. */
export async function setupOwnConfig(
  paths: Paths,
  name: string,
  profile: Profile,
  answers: { agents: string[]; explore: string | null },
  previous: PreviousConfig = {},
): Promise<string[]> {
  if (sharesSessions(profile, loadSettings(paths))) {
    return [
      ...setupMcp(paths, name, profile, previous, true),
      c.dim('  Shares sessions with ~/.claude: no agents or MCP servers of its own while it does.'),
    ]
  }
  return [...setupMcp(paths, name, profile, previous), ...(await setupAgents(paths, name, profile, answers.agents, answers.explore))]
}

/** What follows saving a profile in `add`, `add --default` and `edit`: link its shared config into
 *  its own directory, then set up its MCP servers, agents and Explore model there. A profile that
 *  shares runs in ~/.claude, which is the link source itself and never its own directory, so
 *  neither is done. `previous` is what the profile had before, so what the new answers switch
 *  off (or a different provider's servers) can be taken away. */
export async function settleProfile(
  paths: Paths,
  name: string,
  profile: Profile,
  answers: { agents: string[]; explore: string | null },
  previous: PreviousConfig = {},
): Promise<string[]> {
  if (!sharesSessions(profile, loadSettings(paths))) reconcileLinks(profileDir(paths, name), paths.claudeDir)
  return setupOwnConfig(paths, name, profile, answers, previous)
}
