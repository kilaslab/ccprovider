import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { McpRegion, McpServerSpec, Preset, Profile } from './types.js'

/**
 * Provider-shipped MCP servers, provisioned into a profile's own Claude config.
 *
 * The API key must never be written into that config. Two obvious ways to get it to a
 * remote server both go wrong:
 *
 *   - Writing `Authorization: Bearer <key>` literally puts the key in a plaintext file
 *     (this is what Z.ai's own `coding-helper` does), defeating the keychain.
 *   - `Bearer ${ANTHROPIC_AUTH_TOKEN}` in `headers` looks right and fails: Claude Code
 *     reads its own credential variables as *empty* in a remote server's url/headers,
 *     with no warning, so the server just answers 401. (Measured on Claude Code 2.1.283.)
 *
 * `headersHelper` is the supported route: a command Claude Code runs on every
 * connection, inheriting the session environment, that prints the headers. The token is
 * already in that environment because `ccprovider use` put it there.
 */

/** Refuses anything outside a conservative token alphabet rather than printing it: the
 *  value is spliced into JSON by printf, so a `"` in a key would otherwise let it add
 *  headers of its own. Real provider keys are well inside this set. */
export const HEADERS_HELPER =
  `case "$ANTHROPIC_AUTH_TOKEN" in ''|*[!A-Za-z0-9._~+/=-]*) exit 1;; esac; ` +
  `printf '{"Authorization":"Bearer %s"}' "$ANTHROPIC_AUTH_TOKEN"`

/** The characters `HEADERS_HELPER` will print. Kept beside it, and pinned to it by a test
 *  that runs the real shell snippet, so `doctor` can tell a user whose key falls outside
 *  it — the servers would 401 while everything else looked healthy. */
export const HELPER_KEY_RE = /^[A-Za-z0-9._~+/=-]+$/

export type McpServerJson = Record<string, unknown>

export interface Desired {
  spec: McpServerSpec
  json: McpServerJson
}

/** A server to take away. It is removed only if what is installed equals one of
 *  `accepted` — the definition ccprovider would have written for *any* of the preset's
 *  regions, since the profile may have moved between them since it was added. */
export interface Unwanted {
  spec: McpServerSpec
  accepted: McpServerJson[]
}

/** The region whose `appliesTo` prefix the profile's endpoint falls under. */
export function regionFor(baseUrl: string, preset: Preset | undefined): McpRegion | undefined {
  return preset?.mcp?.regions.find((r) => baseUrl.startsWith(r.appliesTo))
}

/** What `claude mcp add-json` should be given for this server. */
export function serverJson(spec: McpServerSpec, region: McpRegion): McpServerJson {
  if (spec.kind === 'http') {
    return { type: 'http', url: region.origin + spec.path, headersHelper: HEADERS_HELPER }
  }
  return {
    type: 'stdio',
    command: spec.command,
    args: spec.args,
    // Expanded by Claude Code from the session environment when it spawns the server.
    // stdio `env` is not subject to the remote url/headers restriction above.
    env: { [spec.keyEnv]: '${ANTHROPIC_AUTH_TOKEN}', [spec.modeEnv]: region.mode },
  }
}

export interface Resolved {
  region: McpRegion | undefined
  /** Enabled servers that this preset actually defines. */
  servers: Desired[]
  /** Enabled IDs the preset does not define (stale after a preset change). */
  unknown: string[]
}

/** Turn a profile's enabled IDs into concrete server definitions. */
export function resolveServers(profile: Profile, preset: Preset | undefined, ids = profile.mcp ?? []): Resolved {
  const catalog = preset?.mcp?.servers ?? []
  const region = regionFor(profile.baseUrl, preset)
  const servers: Desired[] = []
  const unknown: string[] = []
  for (const id of ids) {
    const spec = catalog.find((s) => s.id === id)
    if (!spec) unknown.push(id)
    else if (region) servers.push({ spec, json: serverJson(spec, region) })
  }
  return { region, servers, unknown }
}

/** Every definition ccprovider could have written for this server, one per region. */
export function definitionsFor(spec: McpServerSpec, preset: Preset): McpServerJson[] {
  return (preset.mcp?.regions ?? []).map((r) => serverJson(spec, r))
}

/** Turn server IDs into removal candidates. IDs the preset does not define are skipped:
 *  there is no definition to recognise them by, so they are not ours to remove. */
export function resolveUnwanted(ids: string[], preset: Preset | undefined): Unwanted[] {
  const out: Unwanted[] = []
  for (const id of ids) {
    const spec = preset?.mcp?.servers.find((s) => s.id === id)
    if (spec && preset) out.push({ spec, accepted: definitionsFor(spec, preset) })
  }
  return out
}

/** Preset servers registered in the profile exactly as ccprovider writes them, whether
 *  or not the profile still asks for them. */
export function registeredIds(installed: Record<string, unknown>, preset: Preset | undefined): string[] {
  if (!preset?.mcp) return []
  return preset.mcp.servers
    .filter((s) => installed[s.id] !== undefined && definitionsFor(s, preset).some((d) => same(installed[s.id], d)))
    .map((s) => s.id)
}

/** Servers registered in the profile's user-scope Claude config. Tolerant on purpose:
 *  a missing or unreadable file just means nothing is installed yet. */
export function readInstalledMcp(dir: string): Record<string, unknown> {
  try {
    const raw = JSON.parse(readFileSync(join(dir, '.claude.json'), 'utf8')) as { mcpServers?: unknown }
    const s = raw.mcpServers
    return typeof s === 'object' && s !== null && !Array.isArray(s) ? (s as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export type McpState = 'ok' | 'missing' | 'drift'

export function compareInstalled(installed: Record<string, unknown>, want: Desired): McpState {
  const have = installed[want.spec.id]
  if (have === undefined) return 'missing'
  return same(have, want.json) ? 'ok' : 'drift'
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  return ka.length === kb.length && ka.every((k) => k in b && same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
}

export interface RunResult {
  status: number | null
  stderr: string
}
export type Run = (args: string[]) => RunResult

/** Run the real `claude` against the profile's config dir. The environment is the
 *  minimum it needs — in particular it carries no API key, since none of these
 *  subcommands talk to a provider. */
export function claudeRunner(claude: string, dir: string, base: NodeJS.ProcessEnv = process.env): Run {
  const env: Record<string, string> = { CLAUDE_CONFIG_DIR: dir }
  for (const k of ['PATH', 'HOME', 'LANG', 'TERM']) if (base[k]) env[k] = base[k]!
  return (args) => {
    const r = spawnSync(claude, args, { env, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] })
    return { status: r.status, stderr: r.error ? r.error.message : (r.stderr ?? '') }
  }
}

export type SyncAction = 'added' | 'updated' | 'unchanged' | 'removed' | 'kept' | 'failed'
export interface SyncResult {
  id: string
  action: SyncAction
  detail?: string
}

/**
 * Make the profile's Claude config match `wanted`.
 *
 * `claude mcp add-json` is the writer, not this code: `.claude.json` is Claude Code's
 * own state file, rewritten constantly while a session runs, so editing it by hand
 * would race with it.
 *
 * `unwanted` are servers the user just switched off. They are removed only if the
 * installed definition is exactly what ccprovider would have written — if the user has
 * since customised one, it is theirs now and is left in place.
 */
export function syncMcp(opts: { run: Run; installed: Record<string, unknown>; wanted: Desired[]; unwanted?: Unwanted[] }): SyncResult[] {
  const { run, installed, wanted, unwanted = [] } = opts
  const results: SyncResult[] = []
  const failure = (r: RunResult) => r.stderr.trim() || `claude exited ${r.status}`

  for (const want of wanted) {
    const id = want.spec.id
    const state = compareInstalled(installed, want)
    if (state === 'ok') {
      results.push({ id, action: 'unchanged' })
      continue
    }

    const prior = installed[id]
    if (prior !== undefined) {
      // If the old entry cannot be removed the add would only fail with "already
      // exists" — and a restore after that would be reported as a loss that never happened.
      const removed = run(['mcp', 'remove', '-s', 'user', id])
      if (removed.status !== 0) {
        results.push({ id, action: 'failed', detail: `could not replace the existing definition: ${failure(removed)}` })
        continue
      }
    }
    const added = run(['mcp', 'add-json', '-s', 'user', id, JSON.stringify(want.json)])
    if (added.status === 0) {
      results.push({ id, action: prior === undefined ? 'added' : 'updated' })
      continue
    }

    // The old entry is already gone. Put it back rather than leave the user with
    // neither the old definition nor the new one — unless it carries a credential of the
    // user's own making (Z.ai's docs have people run `claude mcp add --header "Authorization:
    // Bearer <key>"`). Restoring goes through an argument, and a key never does.
    let detail = failure(added)
    if (prior !== undefined) {
      if (/Bearer\s+[^\s"$]/i.test(JSON.stringify(prior))) {
        detail += ' (the previous definition contains a credential, so it was not re-applied from an argument; add it again with `claude mcp add`)'
      } else {
        const restored = run(['mcp', 'add-json', '-s', 'user', id, JSON.stringify(prior)])
        detail += restored.status === 0 ? ' (previous definition restored)' : ' (and the previous definition could not be restored)'
      }
    }
    results.push({ id, action: 'failed', detail })
  }

  for (const gone of unwanted) {
    const id = gone.spec.id
    if (installed[id] === undefined) continue
    if (!gone.accepted.some((d) => same(installed[id], d))) {
      results.push({ id, action: 'kept', detail: 'customised since it was added, so it was left in place' })
      continue
    }
    const r = run(['mcp', 'remove', '-s', 'user', id])
    results.push(r.status === 0 ? { id, action: 'removed' } : { id, action: 'failed', detail: failure(r) })
  }

  return results
}
