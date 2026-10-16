import { p, orCancel } from './prompts.js'
import { PRESETS, findPreset, MIRRORS, compactWindowFor } from '../presets.js'
import { probeEndpoint, probeModel, OPENAI_GUIDANCE } from '../probe.js'
import { fetchOpenRouterCatalog, fetchGenericCatalog, toolCapable, formatPrice, type ModelInfo } from '../catalog.js'
import { validateName } from '../profile.js'
import { regionFor } from '../mcp.js'
import { AGENT_CATALOG, AGENT_SOURCE, listInstalled, readExplore } from '../agents.js'
import { startChoiceOf } from '../launch.js'
import { profileDir } from '../paths.js'
import { OPUSPLAN, type Profile, type Preset } from '../types.js'
import type { Paths } from '../paths.js'

export interface WizardResult {
  name: string
  profile: Profile
  /** Null for a Claude subscription profile, which stores no key. */
  apiKey: string | null
  /** Catalog agents the profile should have. Written by the caller, like MCP. */
  agents: string[]
  /** Model for the Explore override, or null for Claude Code's built-in Explore. */
  explore: string | null
  /** The name was taken and the user chose to replace that profile: the caller deletes
   *  it before saving this one, so cancelling the wizard loses nothing. */
  replace: boolean
}

/** The name was taken and the user chose to edit that profile instead of adding one. */
export interface EditInstead {
  editInstead: string
}

const CLAUDE_CHOICE = 'claude'

export async function runWizard(
  paths: Paths,
  existing: { name: string; profile: Profile; apiKey: string | null } | null,
  takenNames: string[],
  refresh = false,
): Promise<WizardResult | EditInstead> {
  p.intro(existing ? `Edit profile "${existing.name}"` : 'Add a Claude Code provider')

  // ---- 1. provider
  const presetId = existing?.profile.preset
    ? existing.profile.preset
    : orCancel(
        await p.select({
          message: 'Provider',
          options: [
            { value: CLAUDE_CHOICE, label: 'Claude subscription', hint: 'another Claude login, signed in with /login' },
            ...PRESETS.map((x) => ({ value: x.id, label: x.label })),
          ],
        }),
      )
  if (!existing && presetId === CLAUDE_CHOICE) {
    const picked = await chooseName(takenNames, 'work')
    if ('editInstead' in picked) return picked
    const { name, replace } = picked
    return {
      name,
      profile: { kind: 'oauth', baseUrl: '', aliases: {}, preset: CLAUDE_CHOICE, createdAt: new Date().toISOString() },
      apiKey: null,
      agents: await chooseAgents(null),
      explore: await chooseExplore({}, null),
      replace: replace && (orCancel(await p.confirm({ message: saveMessage(name, true), initialValue: true })) || exitUnsaved()),
    }
  }
  const preset = findPreset(presetId as string)

  // ---- 2. name
  let name: string
  let replace = false
  if (existing) {
    name = existing.name
  } else {
    const picked = await chooseName(takenNames, presetId as string, presetId as string)
    if ('editInstead' in picked) return picked
    ;({ name, replace } = picked)
  }

  // ---- 3. base URL
  //
  // In edit mode always offer it: the stored provider may not match the one just
  // selected (a hand-written profile has no `preset` field, so the select is shown),
  // and silently keeping the old URL produced a profile stamped with one provider
  // while pointing at another.
  let baseUrl = existing?.profile.baseUrl ?? preset?.baseUrl ?? ''
  if (existing && preset && preset.baseUrl && preset.baseUrl !== baseUrl && presetId !== 'custom') {
    const usePreset = orCancel(
      await p.select({
        message: `"${preset.label}" normally uses a different endpoint`,
        options: [
          { value: 'preset', label: preset.baseUrl, hint: 'the preset default' },
          { value: 'keep', label: baseUrl, hint: 'what this profile has now' },
        ],
      }),
    )
    if (usePreset === 'preset') baseUrl = preset.baseUrl
  } else if (!baseUrl || presetId === 'custom') {
    baseUrl = orCancel(
      await p.text({
        message: 'Anthropic-format base URL',
        placeholder: 'http://localhost:4000',
        initialValue: baseUrl,
        validate: (v) => (/^https?:\/\/.+/.test(v ?? '') ? undefined : 'Must be an http(s) URL'),
      }),
    )
  } else {
    const mirror = MIRRORS[presetId as string]
    if (mirror) {
      const choice = orCancel(
        await p.select({
          message: 'Endpoint',
          options: [
            { value: 'primary', label: baseUrl },
            { value: 'mirror', label: mirror, hint: 'China mainland' },
          ],
        }),
      )
      if (choice === 'mirror') baseUrl = mirror
    }
  }

  // ---- 4. does it speak our language?
  const s = p.spinner()
  s.start(`Checking ${baseUrl}`)
  const verdict = await probeEndpoint(baseUrl)
  if (verdict.kind === 'openai-only') {
    s.stop('Wrong API format')
    p.note(OPENAI_GUIDANCE(baseUrl), 'Not supported')
    p.cancel('Nothing was saved.')
    process.exit(1)
  }
  if (verdict.kind === 'unreachable') {
    s.stop('Could not reach it')
    const go = orCancel(await p.confirm({ message: `${verdict.detail}. Save the profile anyway?`, initialValue: false }))
    if (!go) { p.cancel('Nothing was saved.'); process.exit(1) }
  } else if (verdict.kind === 'unknown') {
    s.stop(`Unexpected response (HTTP ${verdict.status})`)
    const go = orCancel(await p.confirm({ message: 'This may not be an Anthropic-format endpoint. Continue?', initialValue: false }))
    if (!go) { p.cancel('Nothing was saved.'); process.exit(1) }
  } else if (verdict.kind === 'inconclusive') {
    // This provider authenticates before it routes, so an unauthenticated request
    // cannot tell a real endpoint from a typo. Say so rather than implying a pass —
    // the authenticated check after the key is what actually settles it.
    s.stop('Reachable, but it answers every path the same — will confirm with your key')
  } else {
    s.stop('Endpoint speaks Anthropic Messages')
  }

  // ---- 5. key
  const apiKey = existing?.apiKey
    ? orCancel(await p.password({ message: 'API key (blank keeps the current one)', mask: '•' })) || existing.apiKey
    : orCancel(await p.password({ message: 'API key', mask: '•', validate: (v) => ((v ?? '').trim() ? undefined : 'Required') }))

  // ---- 6. models
  const catalog = await loadCatalog(preset, paths, apiKey, refresh)
  const { aliases, defaultModel, contextTokens, autoCompactWindow, maxOutputTokens } = await chooseModels(
    catalog,
    preset,
    existing?.profile,
  )

  // ---- 7. the check that actually proves it: a real authenticated request per model.
  // Every distinct one, not just opus — a typo in the sonnet slot would otherwise only
  // surface mid-session, when opusplan leaves plan mode.
  const models = [...new Set(Object.values(aliases))]
  const vs = p.spinner()
  vs.start(`Testing ${models.join(', ')}`)
  const live = await Promise.all(models.map(async (m) => ({ model: m, result: await probeModel(baseUrl, apiKey, m) })))
  const rejected = live.filter((r) => !r.result.ok)
  if (!rejected.length) {
    vs.stop(`${models.length === 1 ? 'Model' : 'Every model'} responded — endpoint, key and model IDs all check out`)
  } else {
    vs.stop('Provider rejected the request')
    for (const { model, result } of rejected) {
      const slots = (Object.keys(aliases) as (keyof typeof aliases)[]).filter((s) => aliases[s] === model)
      p.log.error(`${slots.join(', ')} → ${model}: ${result.error ?? `HTTP ${result.status}`}`)
    }
    const go = orCancel(
      await p.confirm({
        message: 'Save anyway? (`ccprovider doctor` re-runs this check later)',
        initialValue: false,
      }),
    )
    if (!go) { p.cancel('Nothing was saved.'); process.exit(1) }
  }

  // ---- 8. effort
  const effortLevel = existing?.profile.effortLevel ?? preset?.effortLevel ?? null

  // ---- 9. the provider's own MCP servers
  const mcp = await chooseMcp(preset, baseUrl, existing?.profile)

  // ---- 10. agents, and the model Explore runs on
  const dir = profileDir(paths, name)
  const agents = await chooseAgents(existing ? listInstalled(dir).filter((a) => a.known).map((a) => a.id) : null)
  const explore = await chooseExplore(aliases, existing ? (readExplore(dir)?.model ?? null) : null)

  const profile: Profile = {
    baseUrl,
    aliases,
    defaultModel,
    contextTokens,
    autoCompactWindow,
    maxOutputTokens,
    effortLevel,
    blankApiKey: existing?.profile.blankApiKey ?? preset?.blankApiKey ?? false,
    preset: presetId as string,
    mcp,
    createdAt: existing?.profile.createdAt ?? new Date().toISOString(),
  }

  p.note(
    [
      `endpoint   ${baseUrl}`,
      `opus       ${aliases.opus}`,
      `sonnet     ${aliases.sonnet}`,
      `haiku      ${aliases.haiku}`,
      `subagent   ${aliases.subagent}`,
      `start      ${defaultModel === OPUSPLAN ? `opusplan (plan ${aliases.opus} → execute ${aliases.sonnet})` : defaultModel}`,
      contextTokens ? `context    ${contextTokens.toLocaleString()} tokens` : '',
      autoCompactWindow ? `compact at ${autoCompactWindow.toLocaleString()} tokens` : '',
      `agents     ${agents.length ? agents.join(', ') : 'none'}`,
      `explore    ${explore ? `${explore}${aliases[explore as keyof typeof aliases] ? ` (${aliases[explore as keyof typeof aliases]})` : ''}` : 'built-in, on the session model'}`,
    ].filter(Boolean).join('\n'),
    name,
  )

  const ok = orCancel(await p.confirm({ message: saveMessage(name, replace), initialValue: true }))
  if (!ok) { p.cancel('Nothing was saved.'); process.exit(1) }

  return { name, profile, apiKey, agents, explore, replace }
}

/**
 * Which catalog agents the profile gets. A new profile starts with the recommended
 * ones ticked; `edit` and `agents add` start from what is installed, so unticking one
 * removes it.
 */
export async function chooseAgents(installed: string[] | null): Promise<string[]> {
  return orCancel(
    await p.multiselect({
      message: `Agents  (from ${AGENT_SOURCE.repo}, MIT · space to toggle)`,
      options: AGENT_CATALOG.map((a) => ({ value: a.id, label: a.id, hint: a.summary })),
      initialValues: installed ?? AGENT_CATALOG.filter((a) => a.recommended).map((a) => a.id),
      required: false,
    }),
  )
}

/** The model Claude Code's Explore subagent runs on. It follows the session model unless
 *  overridden, and `CLAUDE_CODE_SUBAGENT_MODEL` does not reach it — an override file is
 *  the only per-Explore route. A tier name keeps following the profile's mapping. */
async function chooseExplore(aliases: Partial<Record<'opus' | 'sonnet' | 'haiku', string>>, current: string | null): Promise<string | null> {
  const tiers = ['haiku', 'sonnet', 'opus'] as const
  const custom = current && !(tiers as readonly string[]).includes(current) ? current : null
  const choice = orCancel(
    await p.select({
      message: 'Explore subagent model',
      initialValue: current ?? 'default',
      options: [
        { value: 'default', label: 'default', hint: 'the built-in Explore, on the session model' },
        ...tiers.map((t) => ({ value: t, label: aliases[t] ? `${t.padEnd(8)}  ${aliases[t]}` : t })),
        ...(custom ? [{ value: custom, label: `keep      ${custom}`, hint: 'what this profile uses now' }] : []),
      ],
    }),
  )
  return choice === 'default' ? null : choice
}

/** The last question before anything is written. Replacing says what it deletes,
 *  since that is the one irreversible part of `add`. */
function saveMessage(name: string, replace: boolean): string {
  return replace
    ? `Save, replacing the existing "${name}"? Its key, session history and command are deleted.`
    : 'Save this profile?'
}

function exitUnsaved(): never {
  p.cancel('Nothing was saved.')
  process.exit(1)
}

/**
 * The new profile's name. A taken one is a choice, not a dead end: someone re-adding a
 * profile usually means to replace it, and a validation error they cancel out of is
 * erased from the screen with the prompt, leaving only "Cancelled".
 */
async function chooseName(
  takenNames: string[],
  placeholder: string,
  fallback?: string,
): Promise<{ name: string; replace: boolean } | EditInstead> {
  for (;;) {
    const raw =
      orCancel(
        await p.text({
          message: 'Profile name',
          placeholder,
          ...(fallback ? { defaultValue: fallback } : {}),
          validate: (v) => {
            const n = v || fallback
            if (!n) return `A name is required, e.g. "${placeholder}".`
            try { validateName(n) } catch (e) { return (e as Error).message }
          },
        }),
      ) || fallback!
    const name = validateName(raw)
    // Case-insensitive: "DeepSeek" and "deepseek" would share one directory.
    if (!takenNames.some((t) => t.toLowerCase() === name)) return { name, replace: false }

    const what = orCancel(
      await p.select({
        message: `A profile named "${name}" already exists`,
        options: [
          { value: 'replace', label: `Replace "${name}"`, hint: 'its key, session history and command are deleted once you save the new one' },
          { value: 'edit', label: `Edit "${name}" instead`, hint: 'keeps its key and history' },
          { value: 'rename', label: 'Use another name' },
        ],
      }),
    )
    if (what === 'edit') return { editInstead: name }
    if (what === 'replace') return { name, replace: true }
  }
}

/**
 * Which of the provider's MCP servers to enable.
 *
 * Everything starts ticked the first time, because a provider ships these for its plan
 * subscribers and leaving them off defeats the point. After that the stored choice
 * wins, including "none" — an empty list means the user was asked and declined.
 */
async function chooseMcp(preset: Preset | undefined, baseUrl: string, existing: Profile | undefined): Promise<string[] | undefined> {
  if (!preset?.mcp) return existing?.mcp
  const { note, regions, servers } = preset.mcp

  if (!regionFor(baseUrl, preset)) {
    // Not an error: a custom gateway in front of the provider has no MCP hosts of its own.
    p.log.info(
      `${preset.label}'s MCP servers are only set up for ${regions.map((r) => new URL(r.origin).host).join(' and ')}, ` +
        `not ${baseUrl}, so none are enabled.`,
    )
    return existing?.mcp
  }

  const all = servers.map((s) => s.id)
  return orCancel(
    await p.multiselect({
      message: `${preset.label} MCP tools${note ? `  (${note})` : ''}`,
      options: servers.map((s) => ({ value: s.id, label: s.label, hint: s.summary })),
      initialValues: (existing?.mcp ?? all).filter((id) => all.includes(id)),
      required: false,
    }),
  )
}

async function loadCatalog(preset: Preset | undefined, paths: Paths, apiKey: string, refresh: boolean): Promise<ModelInfo[] | null> {
  if (!preset?.modelsUrl) return null
  const s = p.spinner()
  s.start('Fetching model list')
  try {
    const models =
      preset.liveCatalog === 'openrouter'
        ? await fetchOpenRouterCatalog({ cacheDir: paths.cacheDir, refresh })
        : await fetchGenericCatalog(preset.modelsUrl, apiKey)
    const usable = toolCapable(models)
    const dropped = models.length - usable.length
    s.stop(
      dropped > 0
        ? `${usable.length} usable models (${dropped} hidden — no tool-call support, they cannot drive Claude Code)`
        : `${usable.length} models`,
    )
    return usable.length ? usable : null
  } catch (e) {
    s.stop(`Could not fetch the model list: ${(e as Error).message}`)
    return null
  }
}

async function chooseModels(
  catalog: ModelInfo[] | null,
  preset: Preset | undefined,
  existing: Profile | undefined,
) {
  const prior = existing?.aliases ?? preset?.aliases ?? {}

  const pick = async (message: string, fallback: string | undefined): Promise<string> => {
    if (!catalog) {
      return orCancel(
        await p.text({
          message,
          initialValue: fallback ?? '',
          validate: (v) => ((v ?? '').trim() ? undefined : 'Required'),
        }),
      )
    }
    const options = catalog.map((m) => ({
      value: m.id,
      label: m.id,
      hint: [
        m.contextLength ? `${Math.round(m.contextLength / 1000)}k ctx` : null,
        m.supportsImages ? 'vision' : null,
        formatPrice(m) || null,
      ].filter(Boolean).join(' · '),
    }))
    return orCancel(
      await p.autocomplete({
        message,
        options,
        placeholder: 'type to search',
        ...(fallback && catalog.some((m) => m.id === fallback) ? { initialValue: fallback } : {}),
      }),
    ) as string
  }

  // Opus and Sonnet are asked separately rather than as one "main" model: opusplan plans
  // on one and executes on the other, so a provider with a heavy and a light flagship
  // wants them apart. Where they are the same, the prefill makes it a single Enter.
  const opus = await pick('Opus model    (heavy work · plan mode under opusplan)', prior.opus)
  const sonnet = await pick('Sonnet model  (everyday work · execution under opusplan)', prior.sonnet ?? opus)
  const fast = await pick('Fast model    (Haiku tier + subagents)', prior.haiku)

  // Starts ticked when the profile already maps them apart, so `edit` never collapses them.
  const splitFast = orCancel(
    await p.confirm({
      message: 'Map haiku and subagent separately?',
      initialValue: !!prior.haiku && !!prior.subagent && prior.haiku !== prior.subagent,
    }),
  )
  const aliases = {
    opus,
    sonnet,
    ...(splitFast
      ? { haiku: await pick('haiku tier', fast), subagent: await pick('subagent model', prior.subagent ?? fast) }
      : { haiku: fast, subagent: fast }),
  }

  const defaultModel = await chooseStart(aliases, existing)

  // One context window and one output cap cover the session whichever of opus and sonnet
  // it is on, so they have to fit the smaller of the two.
  const sessionInfo = [aliases.opus, aliases.sonnet].map((id) => catalog?.find((m) => m.id === id))
  const smallest = (of: (m: ModelInfo) => number | null | undefined): number | undefined => {
    const known = sessionInfo.map((m) => (m ? of(m) : null)).filter((v): v is number => !!v)
    return known.length ? Math.min(...known) : undefined
  }
  const suggestedContext =
    smallest((m) => m.contextLength) ?? existing?.contextTokens ?? preset?.contextTokens ?? null

  // Claude Code assumes 200k for any model ID it does not recognise, so getting this
  // right is the difference between using a 262k model fully and losing a quarter of it.
  const contextStr = orCancel(
    await p.text({
      message: "Model's context window (tokens)",
      initialValue: suggestedContext ? String(suggestedContext) : '',
      placeholder: 'blank if unknown — Claude Code will assume 200k',
      validate: (v) => (!v || /^\d+$/.test(v) ? undefined : 'Digits only'),
    }),
  )
  const contextTokens = contextStr ? Number(contextStr) : null

  const suggestedCompact = contextTokens
    ? compactWindowFor(contextTokens)
    : (existing?.autoCompactWindow ?? preset?.autoCompactWindow ?? null)

  const windowStr = orCancel(
    await p.text({
      message: 'Auto-compact at (tokens)',
      initialValue: suggestedCompact ? String(suggestedCompact) : '',
      placeholder: 'blank to use Claude Code defaults',
      validate: (v) => (!v || /^\d+$/.test(v) ? undefined : 'Digits only'),
    }),
  )

  return {
    aliases,
    defaultModel,
    contextTokens,
    autoCompactWindow: windowStr ? Number(windowStr) : null,
    maxOutputTokens: existing?.maxOutputTokens ?? smallest((m) => m.maxOutput) ?? preset?.maxOutputTokens ?? null,
  }
}

/**
 * The model sessions start on. Only asked when opus and sonnet differ — with one model
 * on both, all three choices launch the same thing. `edit` preselects what the profile
 * has now, including a hand-written ID, so re-running it never resets the choice.
 */
async function chooseStart(aliases: { opus: string; sonnet: string }, existing: Profile | undefined): Promise<string> {
  const current = existing ? startChoiceOf(existing) : 'opus'
  const kept = current === 'custom' ? existing!.defaultModel! : null
  if (aliases.opus === aliases.sonnet) return kept ?? aliases.opus

  const choice = orCancel(
    await p.select({
      message: 'Start sessions on',
      initialValue: kept ? 'keep' : current,
      options: [
        { value: 'opus', label: `opus      ${aliases.opus}` },
        { value: 'sonnet', label: `sonnet    ${aliases.sonnet}` },
        { value: 'opusplan', label: 'opusplan', hint: `plan on ${aliases.opus}, execute on ${aliases.sonnet}` },
        ...(kept ? [{ value: 'keep', label: `keep      ${kept}`, hint: 'what this profile starts on now' }] : []),
      ],
    }),
  )
  return choice === 'opusplan' ? OPUSPLAN
    : choice === 'sonnet' ? aliases.sonnet
    : choice === 'keep' ? kept!
    : aliases.opus
}
