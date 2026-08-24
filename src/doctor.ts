import { existsSync } from 'node:fs'
import type { Paths } from './paths.js'
import { profileDir } from './paths.js'
import type { Profile, AliasSlot } from './types.js'
import { inspectLinks, LINKED_ENTRIES } from './configdir.js'
import { missingSlots, SLOT_ENV, findClaude } from './launch.js'
import { probeEndpoint, probeModel } from './probe.js'
import type { SecretStore } from './secrets/index.js'

export type Status = 'ok' | 'warn' | 'fail'
export interface Check {
  label: string
  status: Status
  detail?: string
}

export async function runDoctor(
  name: string,
  profile: Profile,
  paths: Paths,
  secrets: SecretStore,
  opts: { skipNetwork?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<Check[]> {
  const checks: Check[] = []
  const dir = profileDir(paths, name)

  // --- claude binary
  try {
    checks.push({ label: 'claude on PATH', status: 'ok', detail: findClaude(process.env as Record<string, string>) })
  } catch (e) {
    checks.push({ label: 'claude on PATH', status: 'fail', detail: (e as Error).message })
  }

  // --- profile directory and links
  if (!existsSync(dir)) {
    checks.push({ label: 'profile directory', status: 'warn', detail: `${dir} not created yet (next \`use\` will create it)` })
  } else {
    const rows = inspectLinks(dir)
    const broken = rows.filter((r) => r.broken)
    const real = rows.filter((r) => r.target === '(real file, not linked)')
    const linked = rows.filter((r) => r.target && !r.broken && r.target !== '(real file, not linked)')
    checks.push({
      label: 'shared config links',
      status: broken.length ? 'fail' : real.length ? 'warn' : 'ok',
      detail:
        broken.length ? `broken: ${broken.map((r) => r.entry).join(', ')}`
        : real.length ? `not shared (real files): ${real.map((r) => r.entry).join(', ')}`
        : `${linked.length}/${LINKED_ENTRIES.length} linked to ${paths.claudeDir}`,
    })
  }

  // --- alias coverage: the check that catches silent 404s
  const missing = missingSlots(profile)
  checks.push({
    label: 'model tier mapping',
    status: missing.length ? 'fail' : 'ok',
    detail: missing.length
      ? `unmapped: ${missing.join(', ')} — sessions requesting these send a Claude model ID to your provider`
      : 'opus, sonnet, haiku and subagent all mapped',
  })

  // --- credential
  const key = await secrets.get(name)
  checks.push({
    label: `API key (${secrets.name})`,
    status: key ? 'ok' : 'fail',
    detail: key ? 'present' : `no key stored for "${name}" — run \`ccprovider edit ${name}\``,
  })

  if (opts.skipNetwork || !key) return checks

  // --- endpoint
  const verdict = await probeEndpoint(profile.baseUrl, opts.fetchImpl)
  checks.push({
    label: 'endpoint format',
    status: verdict.kind === 'anthropic' ? 'ok' : 'fail',
    detail:
      verdict.kind === 'anthropic' ? `${profile.baseUrl} speaks Anthropic Messages`
      : verdict.kind === 'openai-only' ? 'OpenAI format — needs a LiteLLM front (see `ccprovider add`)'
      : verdict.kind === 'unreachable' ? `unreachable: ${verdict.detail}`
      : `unexpected HTTP ${verdict.status}`,
  })

  // --- every alias slot, for real
  const slots = Object.keys(SLOT_ENV) as AliasSlot[]
  const probes = await Promise.all(
    slots
      .filter((s) => profile.aliases[s])
      .map(async (slot) => ({ slot, model: profile.aliases[slot]!, result: await probeModel(profile.baseUrl, key, profile.aliases[slot]!, opts.fetchImpl) })),
  )
  for (const { slot, model, result } of probes) {
    checks.push({
      label: `  ${slot} -> ${model}`,
      status: result.ok ? 'ok' : 'fail',
      detail: result.ok ? 'resolves' : (result.error ?? `HTTP ${result.status}`),
    })
  }

  return checks
}

export function worstStatus(checks: Check[]): Status {
  if (checks.some((c) => c.status === 'fail')) return 'fail'
  if (checks.some((c) => c.status === 'warn')) return 'warn'
  return 'ok'
}
