#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { readFileSync } from 'node:fs'

import { getPaths } from './paths.js'
import { validateName, ProfileError } from './profile.js'
import { LaunchError } from './launch.js'
import { detectStore } from './secrets/index.js'
import { parseEnvFormat } from './envformat.js'
import { ADD_ONLY_FLAGS, addFlagsFromArgs } from './addflags.js'
import { c, requireName } from './ui.js'
import { cmdAgents } from './commands/agents.js'
import { cmdAdd, cmdAddDefault } from './commands/add.js'
import { cmdEdit } from './commands/edit.js'
import { cmdRename } from './commands/rename.js'
import { cmdInstall } from './commands/install.js'
import { cmdDefault } from './commands/default.js'
import { cmdInit } from './commands/init.js'
import { cmdSettings } from './commands/settings.js'
import { cmdStatusline } from './commands/statusline.js'
import { cmdUsage } from './commands/usage.js'
import { cmdUninstall } from './commands/uninstall.js'
import { cmdList } from './commands/list.js'
import { cmdUse } from './commands/use.js'
import { cmdRemove } from './commands/remove.js'
import { cmdDoctor } from './commands/doctor.js'
import { cmdEnv } from './commands/env.js'

const USAGE = `${c.bold('ccprovider')} — run Claude Code against any Anthropic-compatible provider

  ${c.bold('ccprovider add')}                      set up a provider profile
  ${c.bold('ccprovider add --default')}            set up the profile behind the plain  claude , replacing the current default
  ${c.bold('ccprovider ls')}                       list profiles
  ${c.bold('ccprovider use')} <name> [-m tier]     launch Claude Code with that profile
  ${c.bold('ccprovider edit')} <name>              change a profile
  ${c.bold('ccprovider rename')} <old> <new>       rename a profile, its key, its history and its command
  ${c.bold('ccprovider rm')} <name>                delete a profile, its key and its command (also: delete)
  ${c.bold('ccprovider install')} [name]           make a profile a command:  glm  instead of  ccprovider use glm
  ${c.bold('ccprovider uninstall')} [name]         remove that command
  ${c.bold('ccprovider default')} [name]           make a profile the plain  claude  command (--off: put the real one back)
  ${c.bold('ccprovider doctor')} [name]            check a profile end to end
  ${c.bold('ccprovider usage')} [name]             tokens used per model: input, output and cache
  ${c.bold('ccprovider statusline')} [add|rm]      show context use in Claude Code's footer (one install covers every profile)
  ${c.bold('ccprovider env')} <name> [--format f]  print the variables it would set (sh, dotenv or json)
  ${c.bold('ccprovider agents')} <name>            list a profile's agents and its Explore model
  ${c.bold('ccprovider agents add')} <name> [id…]  install agents (no IDs: pick from the list)
  ${c.bold('ccprovider agents rm')} <name> <id…>   remove agents (-y also removes ones you edited)
  ${c.bold('ccprovider agents explore')} <name> <haiku|sonnet|opus|model-id|default>
                                      choose the model the Explore subagent runs on
  ${c.bold('ccprovider settings')}                 a menu: share sessions (and --resume) with the plain claude, for every profile or one
  ${c.bold('ccprovider settings set')} shareSessions true|false [profile]
                                      the same without the menu, for scripts (settings unset shareSessions <profile> drops an override)
  ${c.bold('ccprovider init')}              put ccprovider's PATH entries into your ~/.zshrc or ~/.bashrc

Options
  -m, --model <tier|id>   opus | sonnet | haiku | opusplan | a provider model ID
  --format <sh|dotenv|json>
                          with env: export lines (default), a Docker --env-file, or an
                          object for the Agent SDK's env option. dotenv and json leave
                          out CLAUDE_CONFIG_DIR, which is a path on this machine
  --refresh               re-fetch the provider's model list
  --no-install            with add: do not install the profile as a command
  --no-statusline         with add: do not offer the token footer
  --default               with add: write the single "default" profile (overwritten in place)
                          and make it the plain  claude  command
  --off                   with default: stop overriding  claude
  --since <7d|YYYY-MM-DD> with usage: only calls from then on
  --by day                with usage: one row per day
  --json                  with usage: exact figures, for scripts
  --rebuild               with usage: forget the ledger and read the transcripts again
  -y, --yes               skip confirmation prompts
  -h, --help              this text

Anything after ${c.bold('--')} is passed straight to claude:
  ccprovider use deepseek -- --resume
An installed command does the same for you:
  deepseek --resume
`

async function main(argv: string[]): Promise<number> {
  const dashdash = argv.indexOf('--')
  const own = dashdash === -1 ? argv : argv.slice(0, dashdash)
  const passthrough = dashdash === -1 ? [] : argv.slice(dashdash + 1)

  const { values, positionals } = parseArgs({
    args: own,
    allowPositionals: true,
    options: {
      model: { type: 'string', short: 'm' },
      format: { type: 'string' },
      off: { type: 'boolean', default: false },
      since: { type: 'string' },
      by: { type: 'string' },
      json: { type: 'boolean', default: false },
      rebuild: { type: 'boolean', default: false },
      refresh: { type: 'boolean', default: false },
      yes: { type: 'boolean', short: 'y', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', default: false },
      // Declared by its full name: parseArgs's `allowNegative` needs a newer Node than
      // this tool's floor, and the flag is only ever meant negatively.
      'no-install': { type: 'boolean', default: false },
      'no-statusline': { type: 'boolean', default: false },
      default: { type: 'boolean', default: false },
      // `add` without the wizard: --provider switches it off, the rest answers its questions.
      provider: { type: 'string' },
      name: { type: 'string' },
      'base-url': { type: 'string' },
      'key-stdin': { type: 'boolean', default: false },
      opus: { type: 'string' },
      sonnet: { type: 'string' },
      haiku: { type: 'string' },
      subagent: { type: 'string' },
      start: { type: 'string' },
      context: { type: 'string' },
      compact: { type: 'string' },
      'share-sessions': { type: 'boolean' },
      'no-share-sessions': { type: 'boolean' },
      agents: { type: 'string' },
      explore: { type: 'string' },
      mcp: { type: 'string' },
      'no-probe': { type: 'boolean', default: false },
      // Written into the default wrapper, not typed: see cmdUse.
      'from-default': { type: 'boolean', default: false },
    },
  })

  const [cmd, name, name2] = positionals
  if (values.version) { console.log(version()); return 0 }
  if (values.help || !cmd || cmd === 'help') { console.log(USAGE); return cmd || values.help ? 0 : 1 }

  // An option that belongs to one command is refused on the others. Ignored without a word,
  // `usage --format json` printed the table with exit 0, and a script piped it to jq.
  const OWNED: Record<string, string> = { format: 'env', since: 'usage', by: 'usage', json: 'usage', rebuild: 'usage', off: 'default', 'no-statusline': 'add', default: 'add', 'from-default': 'use', provider: 'add', ...Object.fromEntries(ADD_ONLY_FLAGS.map((f) => [f, 'add'])) }
  for (const [flag, owner] of Object.entries(OWNED)) {
    const given = (values as Record<string, unknown>)[flag]
    if (given !== undefined && given !== false && cmd !== owner) {
      console.error(`--${flag} only applies to \`ccprovider ${owner}\`, not to \`ccprovider ${cmd}\`.`)
      return 1
    }
  }

  const paths = getPaths()
  const secrets = await detectStore()

  switch (cmd) {
    case 'add':
      if (values.default && values['no-install']) {
        console.error('--no-install does not apply with --default: the default `claude` is never installed as a command of its own.')
        return 1
      }
    {
      const opts = { refresh: values.refresh, install: !values['no-install'], statusline: !values['no-statusline'], flags: addFlagsFromArgs(values), yes: values.yes }
      return values.default ? cmdAddDefault(paths, secrets, opts) : cmdAdd(paths, secrets, opts)
    }
    case 'ls': case 'list': return cmdList(paths, secrets)
    case 'use': return cmdUse(paths, secrets, requireName(name, 'use'), values.model ?? null, passthrough, values['from-default'])
    case 'edit': return cmdEdit(paths, secrets, requireName(name, 'edit'), values.refresh)
    case 'rename': case 'mv': return cmdRename(paths, secrets, requireName(name, 'rename'), requireName(name2, 'rename', 'the new name'), values.yes)
    case 'rm': case 'remove': case 'delete': return cmdRemove(paths, secrets, requireName(name, 'rm'), values.yes)
    case 'install': return cmdInstall(paths, name ? validateName(name) : undefined)
    case 'uninstall': return cmdUninstall(paths, name ? validateName(name) : undefined, values.yes)
    case 'default': return cmdDefault(paths, name ? validateName(name) : undefined, values.off)
    case 'statusline': return cmdStatusline(paths, name)
    case 'usage': return cmdUsage(paths, name ? validateName(name) : undefined, { since: values.since, by: values.by, json: values.json, rebuild: values.rebuild })
    case 'doctor': return cmdDoctor(paths, secrets, name ? validateName(name) : undefined)
    case 'env': return cmdEnv(paths, secrets, requireName(name, 'env'), parseEnvFormat(values.format))
    case 'agents': return cmdAgents(paths, positionals.slice(1), values.yes)
    case 'settings': return cmdSettings(paths, positionals.slice(1))
    case 'init': return cmdInit(paths, values.yes)
    default:
      console.error(`Unknown command "${cmd}".\n`)
      console.log(USAGE)
      return 1
  }
}

/** package.json sits one directory up from both `dist/cli.js` (installed) and
 *  `src/cli.ts` (run from a clone), so this finds it either way. */
function version(): string {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
  } catch {
    return '0.0.0'
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    if (err instanceof ProfileError || err instanceof LaunchError) {
      console.error(c.red(err.message))
      process.exit(1)
    }
    console.error(err)
    process.exit(1)
  })
