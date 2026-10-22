import { spawnSync } from 'node:child_process'

import { getPaths } from '../paths.js'
import { loadStore, getProfile } from '../profile.js'
import { reconcileLinks } from '../configdir.js'
import { configDirEnv, loadSettings, sessionConfigDir, sharesSessions } from '../settings.js'
import { buildEnv, findClaude, missingSlots, passThroughNotice } from '../launch.js'
import { detectStore } from '../secrets/index.js'
import { isClaudeToken, isOauth } from '../types.js'
import { c } from '../ui.js'

export async function cmdUse(
  paths: ReturnType<typeof getPaths>,
  secrets: Awaited<ReturnType<typeof detectStore>>,
  name: string,
  model: string | null,
  passthrough: string[],
  fromDefault = false,
): Promise<number> {
  // The default wrapper, run from inside a session ccprovider started (a hook, a subagent's
  // shell): this is a `claude` inside a session that already has its provider, and moving it
  // to the default profile would send its requests to another provider with another bill.
  // Pass it through to the real claude with the environment it already has. PATH is left alone.
  if (fromDefault && process.env.CCPROVIDER_SESSION) {
    const notice = passThroughNotice(!!process.stderr.isTTY)
    if (notice) console.error(c.dim(notice))
    return launchClaude(findClaude(process.env, [paths.defaultBinDir]), passthrough, definedEnv(process.env))
  }

  const store = loadStore(paths)
  const profile = getProfile(store, name)
  const oauth = isOauth(profile)
  const apiKey = oauth ? '' : ((await secrets.get(name)) ?? '')
  if (!oauth && !apiKey) {
    const what = isClaudeToken(profile) ? 'setup-token' : 'API key'
    console.error(`No ${what} stored for "${name}". Run \`ccprovider edit ${name}\` to set one.`)
    return 1
  }

  const missing = missingSlots(profile)
  if (missing.length) {
    console.error(
      c.yellow(`warning: "${name}" has no model mapped to: ${missing.join(', ')}.\n`) +
        c.dim(`  Sessions requesting those tiers will send a Claude model ID to your provider.\n` +
              `  Fix with \`ccprovider edit ${name}\`.\n`),
    )
  }

  const settings = loadSettings(paths)
  const shared = sharesSessions(profile, settings)
  const dir = sessionConfigDir(paths, name, profile, settings)
  // A shared profile runs in the real config dir — the symlink source itself — so there is
  // nothing to reconcile and nothing of its own to warn about.
  if (!shared) {
    const results = reconcileLinks(dir, paths.claudeDir)
    for (const r of results) {
      if (r.action === 'skipped-real') console.error(c.yellow(`warning: ${r.detail} — not shared with ~/.claude`))
    }
  }

  const env = buildEnv({ profile, configDir: configDirEnv(paths, dir, process.env), apiKey, model, baseEnv: process.env })
  // Marks the session, so a default wrapper run inside it knows it is inside one.
  env.CCPROVIDER_SESSION = '1'
  return launchClaude(findClaude(env, [paths.defaultBinDir]), passthrough, env)
}

/** The environment as `execve` wants it: strings only. */
function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => typeof e[1] === 'string'))
}

function launchClaude(claude: string, passthrough: string[], env: Record<string, string>): number {
  const args = ['claude', ...passthrough]

  // Replace this process so signals, exit codes and the TTY behave exactly as if
  // the user had typed `claude` themselves.
  const execve = (process as unknown as { execve?: (f: string, a: string[], e: Record<string, string>) => never }).execve
  if (typeof execve === 'function') execve(claude, args, env)

  // Node < 24 has no execve; spawn in the same process group instead.
  const r = spawnSync(claude, passthrough, { stdio: 'inherit', env })
  if (r.error) {
    // e.g. claude was removed or lost the executable bit between `which` and spawn
    console.error(c.red(`Could not launch ${claude}: ${r.error.message}`))
    return 1
  }
  if (r.signal) process.kill(process.pid, r.signal)
  return r.status ?? 1
}
