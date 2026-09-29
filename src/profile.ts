import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Paths } from './paths.js'
import type { Profile, ProfileStore, AliasSlot } from './types.js'
import { ALIAS_SLOTS } from './types.js'

export class ProfileError extends Error {}

const EMPTY: ProfileStore = { version: 1, providers: {} }

export function loadStore(paths: Paths): ProfileStore {
  if (!existsSync(paths.configFile)) return structuredClone(EMPTY)
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(paths.configFile, 'utf8'))
  } catch (e) {
    throw new ProfileError(`${paths.configFile} is not valid JSON: ${(e as Error).message}`)
  }
  return validateStore(raw, paths.configFile)
}

export function saveStore(paths: Paths, store: ProfileStore): void {
  mkdirSync(dirname(paths.configFile), { recursive: true })
  // Write-then-rename: a crash mid-write must not leave a truncated config that
  // would lose every profile the user has set up.
  const tmp = `${paths.configFile}.tmp`
  writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, paths.configFile)
}

export function validateStore(raw: unknown, source = 'config'): ProfileStore {
  if (typeof raw !== 'object' || raw === null) throw new ProfileError(`${source}: expected an object`)
  const obj = raw as Record<string, unknown>
  if (obj.version !== 1) throw new ProfileError(`${source}: unsupported version ${String(obj.version)} (expected 1)`)
  const providers = obj.providers
  if (typeof providers !== 'object' || providers === null) throw new ProfileError(`${source}: "providers" must be an object`)

  const out: Record<string, Profile> = {}
  for (const [name, value] of Object.entries(providers as Record<string, unknown>)) {
    // Validate the key, not just the value: it becomes a directory name and a keychain
    // account, and reaches mkdir/symlink through profileDir().
    const key = validateName(name)
    if (key in out) {
      throw new ProfileError(
        `${source}: "${name}" collides with another profile once case is normalised. ` +
          `Rename one of them in ${source}.`,
      )
    }
    out[key] = validateProfile(value, `${source}: profile "${name}"`)
  }
  return { version: 1, providers: out }
}

export function validateProfile(raw: unknown, where: string): Profile {
  if (typeof raw !== 'object' || raw === null) throw new ProfileError(`${where}: expected an object`)
  const p = raw as Record<string, unknown>

  if (p.kind != null && p.kind !== 'oauth') {
    throw new ProfileError(`${where}: unknown kind "${String(p.kind)}" (expected "oauth" or nothing)`)
  }
  if (p.kind === 'oauth') {
    return {
      kind: 'oauth',
      baseUrl: '',
      aliases: {},
      preset: 'claude',
      createdAt: optionalString(p.createdAt, `${where}: createdAt`) ?? undefined,
    }
  }

  if (typeof p.baseUrl !== 'string' || !/^https?:\/\//.test(p.baseUrl)) {
    throw new ProfileError(`${where}: baseUrl must be an http(s) URL`)
  }
  if (typeof p.aliases !== 'object' || p.aliases === null) {
    throw new ProfileError(`${where}: aliases must be an object`)
  }

  const aliases: Partial<Record<AliasSlot, string>> = {}
  for (const [slot, model] of Object.entries(p.aliases as Record<string, unknown>)) {
    if (!ALIAS_SLOTS.includes(slot as AliasSlot)) {
      throw new ProfileError(`${where}: unknown alias slot "${slot}" (expected one of ${ALIAS_SLOTS.join(', ')})`)
    }
    if (typeof model !== 'string' || !model.trim()) {
      throw new ProfileError(`${where}: alias "${slot}" must be a non-empty model ID`)
    }
    aliases[slot as AliasSlot] = model
  }

  return {
    baseUrl: p.baseUrl,
    aliases,
    defaultModel: optionalString(p.defaultModel, `${where}: defaultModel`),
    contextTokens: optionalNumber(p.contextTokens, `${where}: contextTokens`),
    autoCompactWindow: optionalNumber(p.autoCompactWindow, `${where}: autoCompactWindow`),
    maxOutputTokens: optionalNumber(p.maxOutputTokens, `${where}: maxOutputTokens`),
    effortLevel: optionalString(p.effortLevel, `${where}: effortLevel`),
    blankApiKey: p.blankApiKey === true,
    preset: optionalString(p.preset, `${where}: preset`) ?? undefined,
    mcp: optionalIdList(p.mcp, `${where}: mcp`),
    createdAt: optionalString(p.createdAt, `${where}: createdAt`) ?? undefined,
  }
}

/** MCP server IDs become `claude mcp` arguments and JSON keys, so hold them to the
 *  same boring alphabet as profile names.
 *
 *  Absent and empty mean different things and must round-trip as such: absent is "never
 *  asked" (the wizard offers everything), `[]` is "asked, and the answer was none". */
function optionalIdList(v: unknown, where: string): string[] | undefined {
  if (v == null) return undefined
  if (!Array.isArray(v)) throw new ProfileError(`${where} must be an array of server IDs`)
  const ids: string[] = []
  for (const id of v) {
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
      throw new ProfileError(`${where}: "${String(id)}" is not a valid server ID (lowercase letters, digits, dash)`)
    }
    if (!ids.includes(id)) ids.push(id)
  }
  return ids
}

function optionalString(v: unknown, where: string): string | null {
  if (v == null) return null
  if (typeof v !== 'string') throw new ProfileError(`${where} must be a string`)
  return v
}

function optionalNumber(v: unknown, where: string): number | null {
  if (v == null) return null
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
    throw new ProfileError(`${where} must be a non-negative number`)
  }
  return v
}

/**
 * Profile names become directory names and keychain accounts, so keep them boring —
 * and normalise case.
 *
 * macOS and Windows filesystems are case-insensitive by default, so "DeepSeek" and
 * "deepseek" would resolve to one CLAUDE_CONFIG_DIR while being two entries in the
 * config: exactly the state bleed this tool exists to prevent, and `rm` on either
 * would destroy the other's session history. Returns the normalised name; callers
 * must use the return value rather than the argument.
 */
export function validateName(name: string): string {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name)) {
    throw new ProfileError(
      `"${name}" is not a valid profile name. Use letters, digits, dot, dash or underscore (max 64).`,
    )
  }
  return name.toLowerCase()
}

export function getProfile(store: ProfileStore, name: string): Profile {
  const p = store.providers[validateName(name)]
  if (!p) {
    const known = Object.keys(store.providers)
    throw new ProfileError(
      known.length
        ? `No profile named "${name}". Known profiles: ${known.join(', ')}`
        : `No profiles yet. Run \`ccprovider add\` to create one.`,
    )
  }
  return p
}
