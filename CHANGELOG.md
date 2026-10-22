# Changelog

All notable changes are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.6.0] - 2026-10-22

### Added

- **`ccprovider default --use <provider>`** swaps the default `claude` to a provider it kept, with
  no wizard and no key typed. `add --default` no longer deletes what it replaces: the old profile
  and its key (or setup-token) are filed per provider in `slot.json` and the keychain
  (`default:<provider>`), and `default` lists them; `default --forget <provider>` drops one. The
  directory is the same through every swap, so `claude --continue` picks a session up on the
  other provider; `--use` warns when the two differ in sharing and the session would not be found.
  A `/login` is set aside (`.credentials.stashed.json`) instead of deleted and comes back with it.
  `ls` shows the stashed line under `default`, `doctor` checks each stashed key, and `rm default`
  removes them all.
- **`ccprovider add` without the wizard.** `--provider <id>` switches the wizard off and the rest
  of the flags answer its questions: `--key-stdin` (the key comes from standard input, never an
  argument), `--name`, `--base-url`, `--opus --sonnet --haiku --subagent`, `--start`, `--context`,
  `--compact`, `--share-sessions` / `--no-share-sessions`, `--agents`, `--explore`, `--mcp`,
  `--no-probe`. Nothing is asked: what the wizard would confirm is refused (replacing the default
  needs `-y`), and a failed check of the endpoint or a model exits non-zero. Combine with
  `--default` to set the default from a script.
- **`usage` tells a default that changed provider apart by when each call was made.** The default
  records the time of every change, and its rows are grouped by the provider each call went to:
  a provider answering under a Claude model name is no longer counted as a subscription. `--json`
  rows gain `era`.

### Changed

- **`default` is a reserved profile name** for `add --default`: `add` and `rename` refuse it as a
  new name. A profile called `default` from before keeps loading and running, and can be renamed
  away until it has been used as the slot. Once it has stashed providers it cannot be renamed.
- `cli.ts` is split into one module per command (`src/commands/`) and shared helpers (`src/ui.ts`,
  `src/pathhint.ts`, `src/setup.ts`), with no change in behaviour. `setupMcp` plans its changes in
  a pure `planMcp`, which has tests, along with the wizard (scripted prompts) and the new flows.

## [0.5.0] - 2026-10-22

### Added

- **Claude subscription (setup-token)**, a new provider in `add`. Paste the token from
  `claude setup-token`; it is stored like an API key and passed to Claude Code as
  `CLAUDE_CODE_OAUTH_TOKEN`. `doctor` checks the token is present and looks like one.
- **`ccprovider add --default`** writes one profile called `default` and makes the plain
  `claude` run it. Running it again overwrites that profile (new key, new provider, same
  sessions) instead of adding another.

### Changed

- `ccprovider env` (the `sh` form) now also prints `unset` for the model and endpoint variables
  a profile does not set, as `use` deletes them, so `eval` of a subscription profile after a
  provider's no longer leaves the provider's base URL and token in the shell.
- `ccprovider ls` and `doctor` show the profile behind `add --default` as the default `claude`
  command, and not as a missing launcher.
- `ccprovider usage` splits a Claude profile's rows into Claude models and "not Claude models —
  from an earlier provider", for a default that was a provider before it became a subscription.
- A setup-token profile may share chat sessions with the plain `claude`, which a `/login`
  profile still cannot: its credential is in the environment, not in a config directory.

## [0.4.0] - 2026-10-21

### Added

- **`add` and `edit` ask whether the profile shares its chat sessions** with the plain
  `claude` ("Share chat sessions with the plain claude?"), starting on No unless the global
  default says otherwise. An answer that only repeats the default is not stored, so the
  profile keeps following it; a different one becomes the profile's own override. It is asked
  before MCP servers, agents and the Explore model, which are skipped while the profile shares:
  it has no config directory of its own to put them in.

### Changed

- **`ccprovider settings` is a menu at a terminal.** It lists the global default and every
  profile with what each resolves to; pick one to change it, and each change is saved as it is
  made. Piped, it prints the same list and now ends with the command to change it. `settings
  set` and `settings unset` work as before for scripts, and now say so when the value was
  already set. The hint line goes to stderr, so a script reading the list gets only the list.
- `edit` no longer copies a profile's sharing override over whatever the wizard decided: the
  wizard owns it now. Answering so a profile lands back on the default (Yes to share, later No,
  with the default off) drops its override, so it follows the default again.
- `settings set shareSessions true ""` is refused instead of changing the global default.

## [0.3.0] - 2026-10-20

### Added

- **`ccprovider settings`**, and session sharing. `settings set shareSessions true|false`
  sets a global default; passing a profile (`… true glm`) sets that profile's own override,
  and `settings unset shareSessions <profile>` drops it again. A sharing profile runs its
  sessions in `~/.claude` itself, so its `--resume` history, todos and credentials are the
  plain `claude`'s. Safety rails: a Claude subscription profile never shares (its login
  lives in its own config directory, and the store refuses the field on one outright);
  agents and MCP servers are refused while a profile shares (there is nothing of its own
  to register them in); a shared session leaves `CLAUDE_CONFIG_DIR` unset unless you set it
  yourself, because Claude Code keeps its global state in `~/.claude.json` then and in
  `~/.claude/.claude.json` when it is set; `doctor` and `ls` report the shared directory; `usage` adds a
  `shared` group with its own ledger, so nothing is counted twice and nothing is
  attributed to the wrong profile.
- **`ccprovider init`** adds ccprovider's `PATH` entries to your `~/.zshrc` or bash startup
  file (`~/.bashrc`; on macOS the first of `~/.bash_profile`, `~/.bash_login` and `~/.profile`
  that exists, since Terminal and iTerm start login shells), between `# >>> ccprovider path >>>` marker lines that replace themselves on re-run and
  never touch anything around them. It refuses to edit a shell it does not know or a file
  it cannot be watched editing: without `-y` or a terminal it prints what it would add and
  stops. `ccprovider default` now offers the same write at a terminal when it reports that
  the directory is not in front on `PATH`; non-interactive output is unchanged.

### Fixed

- **A provider session no longer says it has no Bash.** Claude Code defers most tools behind
  a `ToolSearch` tool, and a third-party model does not use it: with the glm profile as the
  default `claude`, glm-5.3-flash treated `ToolSearch` as its only tool and answered that it
  had no shell, with `Bash` in the session's tool list. `use` and `env` now set
  `ENABLE_TOOL_SEARCH=false` for a provider profile, so every tool's schema is sent up front
  (a subscription profile is untouched). The cost is a larger first request, most of all with
  many MCP plugins on. The variable in your shell does not change this; a gateway that does
  support tool search can opt back in through the `env` block of `settings.json`, which wins
  over the environment, and `doctor` then warns, as it does for every variable ccprovider sets.

## [0.2.1] - 2026-10-19

### Changed

- **ccprovider is on npm as `@kilaslab/ccprovider`**: `npm install -g @kilaslab/ccprovider`.
  The command is still `ccprovider`. Each release is published with a provenance statement,
  from the same tarball that goes on the GitHub release.
- Release tarballs are named `kilaslab-ccprovider-X.Y.Z.tgz` (they were `ccprovider-X.Y.Z.tgz`
  up to 0.2.0).

## [0.2.0] - 2026-10-17

### Added

- **`ccprovider env <name> --format dotenv|json`**, for running a profile somewhere that is
  not your shell: `docker run --env-file <(ccprovider env glm --format dotenv)`, or the
  `env` option of the Claude Agent SDK. Both leave out `CLAUDE_CONFIG_DIR` (a path on this
  machine) and carry the credential and routing variables empty (see Changed below for why).
  The default is still the `export` listing.
- `docs/agent-sdk.md`: working TypeScript, Python and Docker examples, and what the SDK
  loads from `~/.claude` by default.
- **`ccprovider default <profile>`** makes a profile the plain `claude` command, for a
  machine that only uses one provider; `--off` puts the real one back. It writes a script
  into `~/.local/share/ccprovider/bin/` that you put before Claude Code's directory on
  `PATH`, and leaves `~/.local/bin/claude` (which its updater rewrites) and
  `~/.claude/settings.json` (which every profile shares) alone. `rename` and `rm` keep it
  in step with its profile, and `doctor` reports it. See `docs/default-command.md`.

- **`ccprovider usage [name]`** shows the tokens each profile used, per model: input,
  output, cache read, cache write and the cache hit rate (`--since 7d`, `--by day`,
  `--json`, `--rebuild`, which keeps the ledger it replaces as `.bak`). It reads the
  transcripts Claude Code keeps in each profile,
  grouping the several snapshot lines of one call by message id and keeping the largest
  figures, counting subagents, and treating a cache a provider does not report as unknown
  and not as zero. A ledger remembers how far it has read: a 3.3 GB profile took about 8
  seconds the first time and 0.1 s after. The ledger keeps what it counted after Claude
  Code deletes old transcripts, and follows a profile through `rename` and `rm`. See
  `docs/usage.md`.

- **`ccprovider statusline [add|rm]`** and an offer on `ccprovider add` (default Yes, asked
  once; `--no-statusline` skips it) for the token badge in Claude Code's footer. It is
  cc-token-statusline by Alfafis (MIT), pinned to one upstream commit with a sha256 per file
  and installed by upstream's own installer, which backs up `settings.json` and wraps a status
  line you already have. It goes into the real config directory, not the profile it is run
  from, so one install covers every profile. `doctor` reports it; a footer whose script is gone
  is a failure, since a failing status line command hides the whole bar. Needs a python that
  actually runs (the macOS stub is skipped, with the remedy named), and `rm` counts as a no
  so `add` does not offer it again. See `docs/statusline.md`, which also records what the badge gets right and wrong off Anthropic's
  models: context is correct, but its optional token totals read two to three times too high
  on GLM and its quota segment is empty, so only the correct defaults are used.

- `ccprovider env` (the default `sh` format too) now neutralises the seven credential and routing
  variables `use` deletes from a launch (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`,
  `ANTHROPIC_CUSTOM_HEADERS`, the Bedrock and Vertex base URLs and `CLAUDE_CODE_USE_BEDROCK`/
  `_VERTEX`): `unset` in the shell form, an empty value in `dotenv` and `json`, which cannot
  unset. Measured against a fake provider, left in place an Anthropic `x-api-key` and a custom
  header both reached it, and the Bedrock flag kept any request from reaching it; emptied,
  neither happened and routing was normal. So `eval "$(ccprovider env glm)"`, an `--env-file`
  and an SDK `env` no longer carry them to the provider.
- `ccprovider env --format dotenv` names, on stderr and never with the value, any variable
  whose value Compose's `env_file` or python-dotenv would alter; `docker run --env-file`
  reads them as they are.

### Fixed

- A profile named `constructor` (or anything else a plain object inherits) was treated as
  already existing by `getProfile`, as colliding by the store check, and as reserved by the
  command-name check; all three now look at own keys only.
- `ccprovider statusline add` no longer fails when your status line already runs the badge (a
  script that calls it among other things): upstream refreshes the badge's copy and leaves
  `statusLine` alone, which is now reported as done.
- `ccprovider use` also skips a symlink to the default wrapper, not just the file.
- Replacing a profile with `ccprovider add` no longer drops the default `claude` wrapper that named
  it, which silently put plain `claude` back to stock Claude Code.
- `usage` remembers the position in transcripts that held no countable call (they were read from
  the first byte on every run), and forgets the position of one that was emptied (it was resumed in
  the middle once it grew back).
- `ccprovider use` skips the default wrapper by what the file is, not only by its directory, so
  a wrapper left where `default` made it after `CCPROVIDER_DEFAULT_BIN_DIR` or `XDG_DATA_HOME`
  changed can no longer be found as `claude` and run in an endless loop.
- `usage` keeps every ledger it cannot read (`.damaged`, `.damaged.2`, ...) instead of only the
  first, replaces it with an empty one so it is set aside once and not on every run, and treats a ledger with an entry that makes no sense as unreadable, not as valid.

### Changed

- An option that belongs to one command (`--format`, `--since`, `--by`, `--json`, `--rebuild`,
  `--off`, `--no-statusline`) is refused on the others, instead of being ignored: `usage --format
  json` used to print the table with exit 0.
- `ccprovider statusline add` checks for a working python before it downloads anything, so
  offline or without python you are told the real blocker.
- A status line script of yours that calls the badge is recognised as the footer, so it is not
  offered again after `add`. A command using `$CLAUDE_CONFIG_DIR` is judged by the variable as
  set, not as the real config directory, which would hide a footer that fails in a profile.
- `ccprovider doctor` no longer stops at "No profiles yet": the default `claude`, the footer and
  leftover commands do not need a profile to be broken.
- A token footer newer than the pinned one is left alone by `statusline add` and not reported as
  stale by `doctor`.
- `python3` and `python` can no longer be installed as command names: ccprovider runs them for
  the token footer, and skips a launcher of ccprovider's own that already has one of those names.
- `rename` stops when any usage is already filed under the new name, and says what to do: move it
  aside if it is a deleted profile's, or `mv` it back if an earlier rename of this profile was
  interrupted. Guessing either way would hand a profile somebody else's numbers or lose its own.
- `usage` prints colour only to a terminal, and never when `NO_COLOR` is set.
- A `claude` run inside a session that `ccprovider use` started (a hook, a subagent's shell) is
  no longer pulled onto the default profile. Sessions carry `CCPROVIDER_SESSION=1`, and the
  default wrapper, which says it is the default (`--from-default`), passes straight through to
  the real `claude` with the session's own environment when it finds the mark. PATH is not
  touched.
- A token footer whose script sits inside a profile's directory (what the plugin's own session
  nudge produces when it is followed from a profile) is flagged by `doctor` and `statusline`,
  warned about by `rm` before that profile is deleted, and moved into the real config directory by
  `statusline add`. Removing that profile would otherwise hide the status bar in every profile.
- Undoing a failed `rename` puts the default wrapper back with the launcher and node it had.
- `statusline add` no longer says "Installing" when the footer is already up to date.
- `usage` also compares the last 256 bytes before the stored position, so a transcript that was
  rewound and then grew past its old size is read again instead of being resumed in the middle.
- The token footer is recognised by the badge's file name, not by the name appearing anywhere in
  the command, so `my_tokens_statusline.py` is not taken for it.
- The default wrapper tells a person at a terminal when it passed a `claude` through because it
  was run inside a session (a tmux begun from one, say); a hook's stderr stays clean.
- A ledger written by a newer ccprovider is left exactly as it is: `usage` reports from the
  transcripts that still exist and does not save, instead of replacing it with an empty one.
- `statusline` no longer tells the owner of a script that calls the badge to "update" it, which
  `doctor` did not either; the command is read with single quotes and `${VAR:-default}`; the
  chain wrapper is not "working" without the badge; and installing says that it is working.
- `usage` no longer overwrites a ledger it cannot read (it keeps it as `.damaged`), a second
  `--rebuild` keeps the `.bak` that holds more, any message id is accepted whatever its
  spelling, one transcript that cannot be opened no longer aborts the report, and a very long
  line is read in linear time.
- `which` is no longer a reserved command name: `ccprovider use` stopped running it when it
  began finding `claude` itself.
- `ccprovider use` now finds `claude` by walking `PATH` itself, and skips the default
  wrapper's directory, instead of asking `which`. A wrapper called `claude` can no longer
  call itself, and a `PATH` with no `which` on it no longer breaks the lookup.

## [0.1.4] - 2026-10-16

### Added

- **Agents per profile, from an open-source collection.** `add` offers nine subagents
  from VoltAgent/awesome-claude-code-subagents (MIT), with code-reviewer,
  architect-reviewer, test-automator, debugger and security-auditor ticked. They are
  installed into that profile only, pinned to one upstream commit and hash-checked, with
  the source and licence in a frontmatter comment that never reaches the model. `edit`
  and the new `ccprovider agents [add|rm] <name>` change them later.
- **Explore's model per profile.** `add` and `ccprovider agents explore <name> <model>`
  give the profile a read-only Explore subagent on the model of your choice, such as
  the cheap haiku slot. `CLAUDE_CODE_SUBAGENT_MODEL` does not reach the built-in one.
- A profile's `agents` directory can now hold its own agents beside per-file links to
  `~/.claude/agents`, and goes back to the plain shared link once it has none.
  `doctor` reports installed agents and any you have edited.
- `ccprovider delete <name>` works as `rm`.

### Fixed

- **Re-adding a profile under a name that already exists.** `add` rejected the name with
  a validation error, and cancelling out of it erased the error, leaving only "Cancelled
  — nothing was saved". It now offers to replace that profile (deleted only once you
  confirm the new one), edit it instead, or use another name.
- `uninstall <name>` says the profile is still there, and how to delete it or bring the
  command back. It removes only the command, which read like deleting the profile.

## [0.1.3] - 2026-10-16

### Added

- **Opus and Sonnet are chosen separately, and sessions can start on `opusplan`.** `add` and
  `edit` ask for an Opus, a Sonnet and a Fast model instead of one "main" model for both
  tiers. When Opus and Sonnet differ, they ask what sessions start on: opus, sonnet, or
  `opusplan`, which plans on the opus model and executes on the sonnet one. `-m opusplan`
  works too, and refuses a profile with either tier unmapped.
- Setup probes every distinct model in the profile, not just the opus one, and names the
  slot of any model the provider rejects.
- `ls` shows the start model when it is not the opus one.

### Fixed

- `edit` no longer collapses a profile's separate opus/sonnet or haiku/subagent models into
  one each, and no longer resets the start model to opus.
- The suggested context window and output cap fit the smaller of the opus and sonnet
  models, since one setting covers both.

## [0.1.2] - 2026-09-30

### Fixed

- **Launchers no longer run a project's `node` wrapper.** A launcher ran `dist/cli.js` through
  its `#!/usr/bin/env node` shebang, so inside a project whose `.envrc` puts a `.bin/node`
  wrapper first on `PATH` (`docker compose exec app node`), every launcher started ccprovider
  in the container and failed with `service "app" is not running`. A launcher now tries the
  `node` that installed it first, and falls back on the shebang only once that file is gone,
  so changing Node version under nvm or fnm still does not break it. Run `ccprovider install`
  to refresh existing launchers.

## [0.1.1] - 2026-09-29

### Changed

- **Distributed as an npm package again, not as compiled binaries.** A compiled binary is
  the Bun runtime plus about 200 KB of ccprovider (measured: an empty program compiled is
  59 MB, and no compile flag changes that), against a 44 KB package. It needs Node 20.11+.
- **Launchers point at the installed `dist/cli.js`** and let its shebang find `node`, instead of
  baking in the interpreter's path, which changes with every Node version under nvm or fnm.

### Added

- **Claude subscription profiles.** `ccprovider add` can now create a profile that is a second
  Claude login rather than an API-key provider, so a personal and a work subscription can be
  signed in at once. It gets its own config directory and stores no key; `/login` on first
  launch. `ls`, `use`, `env`, `rm` and `doctor` understand it.
- Use without the registry: clone, `npm install && npm link`. `prepare` builds `dist/`.
- The release workflow packs the tarball, proves it installs and runs under Node, attests its
  provenance, creates the GitHub release, and publishes to npm when an `NPM_TOKEN` secret exists.
- CI installs the packed tarball under Node 20, 22 and 24, and a `fresh-install` job does what a
  user's clone does — `npm install` with the newest dependencies, ignoring `bun.lock`.

### Fixed

- A fresh `npm install` failed to compile against @clack/prompts 1.8 (its cancel marker became a
  `unique symbol`). `orCancel` is now typed to work with the old and the new typing.

### Removed

- The compiled binaries, `install.sh` and `THIRD_PARTY_NOTICES.md`. They were only ever in 0.1.0.

## [0.1.0] - 2026-09-26

The first public release.

### Added

- **Provider profiles for Claude Code.** `add`, `ls`, `use`, `edit`, `rm`, `doctor` and
  `env`, for DeepSeek, OpenRouter, Kimi, GLM, MiniMax and custom Anthropic-format
  endpoints. Every model tier and the subagent model are mapped, each profile has its own
  session history, and skills, plugins, rules, `CLAUDE.md` and `settings.json` are shared
  by symlink.
- **Profiles as commands.** `add` installs a profile as a command of the same name
  (`glm` instead of `ccprovider use glm`), as a small `/bin/sh` launcher in
  `~/.local/bin`. `install` and `uninstall` manage them after the fact. Launchers hold no
  key and never overwrite a file ccprovider did not write. They refuse the names of programs
  ccprovider itself resolves through `PATH` (`claude`, `ccprovider`, `which`, `security`,
  `secret-tool`, `node`, `npx`), and `add` does not install one over a real program of the
  same name.
- **`rename`.** Renames a profile together with its config entry, directory, stored key
  and command, with rollback if any step fails, and reports Python virtualenvs inside the
  profile that the move leaves pointing at the old path.
- **GLM MCP servers.** The GLM preset offers Z.ai's vision, web-search, web-reader and
  zread servers, for both the international and mainland endpoints. Servers are registered
  inside the profile's own Claude config, and authenticate through a `headersHelper` so
  the key is never written to a file.
- **`doctor` checks** for the installed command, PATH shadowing, leftover commands, MCP
  registration and drift, the runtime the stdio server needs, and a shared `settings.json`
  that sets `ANTHROPIC_*` variables (which Claude Code applies over a profile's own).
- **Self-contained binaries** for macOS and Linux on arm64 and x64, published with
  `SHA256SUMS`, a signed build-provenance attestation, and `install.sh`.

### Security

- API keys are held in the OS secret store and never written to `providers.json`, a
  launcher or an MCP config. A Claude subscription credential is never passed to a
  third-party endpoint.
- The vision MCP server's npm package is pinned to an exact version.

[Unreleased]: https://github.com/kilaslab/ccprovider/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/kilaslab/ccprovider/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/kilaslab/ccprovider/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/kilaslab/ccprovider/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/kilaslab/ccprovider/compare/v0.1.4...v0.2.0
[0.1.4]: https://github.com/kilaslab/ccprovider/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/kilaslab/ccprovider/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/kilaslab/ccprovider/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/kilaslab/ccprovider/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/kilaslab/ccprovider/releases/tag/v0.1.0
