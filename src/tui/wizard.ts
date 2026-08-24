import { p, orCancel } from './prompts.js'
import { PRESETS, findPreset, MIRRORS, compactWindowFor } from '../presets.js'
import { probeEndpoint, probeModel, OPENAI_GUIDANCE } from '../probe.js'
import { fetchOpenRouterCatalog, fetchGenericCatalog, toolCapable, formatPrice, type ModelInfo } from '../catalog.js'
import { validateName } from '../profile.js'
import type { Profile, Preset } from '../types.js'
import type { Paths } from '../paths.js'

export interface WizardResult {
  name: string
  profile: Profile
  apiKey: string
}

export async function runWizard(
  paths: Paths,
  existing: { name: string; profile: Profile; apiKey: string | null } | null,
  takenNames: string[],
  refresh = false,
): Promise<WizardResult> {
  p.intro(existing ? `Edit profile "${existing.name}"` : 'Add a Claude Code provider')

  // ---- 1. provider
  const presetId = existing?.profile.preset
    ? existing.profile.preset
    : orCancel(
        await p.select({
          message: 'Provider',
          options: PRESETS.map((x) => ({ value: x.id, label: x.label })),
        }),
      )
  const preset = findPreset(presetId as string)

  // ---- 2. name
  const name = existing
    ? existing.name
    : validateName(
        orCancel(
          await p.text({
            message: 'Profile name',
            placeholder: presetId as string,
            defaultValue: presetId as string,
            validate: (v) => {
              const raw = v || (presetId as string)
              let n: string
              try { n = validateName(raw) } catch (e) { return (e as Error).message }
              // Case-insensitive: "DeepSeek" and "deepseek" would share one directory.
              if (takenNames.some((t) => t.toLowerCase() === n)) {
                return `"${n}" already exists — pick another name or run \`ccprovider edit ${n}\`.`
              }
            },
          }),
        ) || (presetId as string),
      )

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

  // ---- 7. the check that actually proves it: a real authenticated request
  const vs = p.spinner()
  vs.start(`Testing ${aliases.opus}`)
  const live = await probeModel(baseUrl, apiKey, aliases.opus)
  if (live.ok) {
    vs.stop('Model responded — endpoint, key and model ID all check out')
  } else {
    vs.stop(`Provider rejected the request: ${live.error ?? `HTTP ${live.status}`}`)
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
    createdAt: existing?.profile.createdAt ?? new Date().toISOString(),
  }

  p.note(
    [
      `endpoint   ${baseUrl}`,
      `opus       ${aliases.opus}`,
      `sonnet     ${aliases.sonnet}`,
      `haiku      ${aliases.haiku}`,
      `subagent   ${aliases.subagent}`,
      contextTokens ? `context    ${contextTokens.toLocaleString()} tokens` : '',
      autoCompactWindow ? `compact at ${autoCompactWindow.toLocaleString()} tokens` : '',
    ].filter(Boolean).join('\n'),
    name,
  )

  const ok = orCancel(await p.confirm({ message: 'Save this profile?', initialValue: true }))
  if (!ok) { p.cancel('Nothing was saved.'); process.exit(1) }

  return { name, profile, apiKey }
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

  const main = await pick('Main model  (Opus + Sonnet tiers)', prior.opus)
  const fast = await pick('Fast model  (Haiku tier + subagents)', prior.haiku)

  const advanced = orCancel(
    await p.confirm({ message: 'Map each tier separately instead?', initialValue: false }),
  )

  const aliases = advanced
    ? {
        opus: await pick('opus tier', main),
        sonnet: await pick('sonnet tier', main),
        haiku: await pick('haiku tier', fast),
        subagent: await pick('subagent model', fast),
      }
    : { opus: main, sonnet: main, haiku: fast, subagent: fast }

  const mainInfo = catalog?.find((m) => m.id === aliases.opus)
  const suggestedContext =
    mainInfo?.contextLength ?? existing?.contextTokens ?? preset?.contextTokens ?? null

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
    defaultModel: aliases.opus,
    contextTokens,
    autoCompactWindow: windowStr ? Number(windowStr) : null,
    maxOutputTokens: existing?.maxOutputTokens ?? mainInfo?.maxOutput ?? preset?.maxOutputTokens ?? null,
  }
}
