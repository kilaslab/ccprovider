# ccprovider

[![CI](https://github.com/kilaslab/ccprovider/actions/workflows/ci.yml/badge.svg)](https://github.com/kilaslab/ccprovider/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Run Claude Code against DeepSeek, OpenRouter, Kimi, GLM, MiniMax, or any other
Anthropic-compatible endpoint — each as a named profile with its own session history,
sharing the skills and plugins you already have. Every profile is also a command:
`glm`, `deepseek`, whatever you named it.

```bash
curl -fsSL https://github.com/kilaslab/ccprovider/releases/latest/download/install.sh | sh

ccprovider add              # pick a provider, paste a key
deepseek                    # launches claude, pointed at DeepSeek
```

One self-contained binary — no Node, no Bun, no npm. macOS and Linux, arm64 and x64.

No proxy. No request translation. `ccprovider` sets environment variables and `exec`s
the real `claude` binary — nothing sits in the request path.

<details>
<summary>Other ways to install</summary>

**From source** (needs [Bun](https://bun.sh)):

```bash
git clone https://github.com/kilaslab/ccprovider && cd ccprovider
bun install
bun run install:local       # builds, then installs to ~/.local/bin/ccprovider
```

**By hand.** Download `ccprovider-<os>-<arch>` and `SHA256SUMS` from the
[releases page](https://github.com/kilaslab/ccprovider/releases), check it with
`shasum -a 256 -c --ignore-missing SHA256SUMS` (macOS) or
`sha256sum -c --ignore-missing SHA256SUMS` (Linux), and put it on your `PATH`.

Every release binary carries a signed build-provenance attestation. To confirm a file
was built by this repository's release workflow and not just uploaded:

```bash
gh attestation verify ccprovider-darwin-arm64 --repo kilaslab/ccprovider
```

`install.sh` checks the checksum on every install. A checksum shipped beside the binary
catches corruption and truncation; it cannot, on its own, catch a compromised release —
that is what the attestation is for.

</details>

## Why not just export the variables yourself

You can. The reason this exists is that the hand-rolled version is wrong in ways that
don't announce themselves.

**Claude Code resolves models by tier, not by ID.** `/model` offers Opus/Sonnet/Haiku.
Subagents request a tier by name. Background summarisation asks for haiku. If you set
only `ANTHROPIC_MODEL`, every one of those still asks for a *Claude* model ID that your
provider has never heard of. The session appears to work, then Task spawns fail and
background requests 404 silently.

A correct setup maps every slot:

```bash
ANTHROPIC_MODEL=deepseek-v4-pro[1m]
ANTHROPIC_DEFAULT_OPUS_MODEL=deepseek-v4-pro[1m]
ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek-v4-pro[1m]
ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-v4-flash
CLAUDE_CODE_SUBAGENT_MODEL=deepseek-v4-flash    # ← the one everyone forgets
```

**Claude Code assumes 200k for any model it doesn't recognise** — which is every
third-party model ID. It says so out loud if you look: `[claude-code:unrecognized_model]`.
Set only `CLAUDE_CODE_AUTO_COMPACT_WINDOW` and a 262k model still gets truncated to 200k.
The real window has to be declared:

```bash
CLAUDE_CODE_MAX_CONTEXT_TOKENS=1048576      # the model's true window
CLAUDE_CODE_AUTO_COMPACT_WINDOW=786432      # compact below it, for headroom
```

The `[1m]` suffix covers the 1M case; this covers every other size.

**Not every model can drive an agent.** Of OpenRouter's 400+ models, roughly 70 can't
tool-call at all. Pick one and Claude Code looks broken rather than telling you why.
`ccprovider add` hides them.

**Launching from inside a Claude Code session leaks the parent's identity.** An existing
session exports `CLAUDE_CODE_SESSION_ID` and a messaging socket to its children; inherit
those and the new instance attaches to the wrong session. `ccprovider` strips them.

## Profiles are isolated but not duplicated

Each profile gets its own config directory. Your skills, plugins, rules, `CLAUDE.md` and
`settings.json` are **symlinked** from `~/.claude`, so they're shared and stay in sync —
install a skill once and every profile sees it. Session history, `projects/`, and cost
tracking are per-profile and never mix.

```
~/.local/share/ccprovider/dirs/deepseek/
├── skills        -> ~/.claude/skills
├── plugins       -> ~/.claude/plugins
├── rules         -> ~/.claude/rules
├── CLAUDE.md     -> ~/.claude/CLAUDE.md
├── settings.json -> ~/.claude/settings.json
├── history.jsonl     (this profile only)
└── sessions/         (this profile only)
```

Links are reconciled before every launch, so anything you add to `~/.claude` later shows
up without re-running setup. `ccprovider rm` unlinks rather than follows — your real
config is never touched.

## Commands

| | |
|---|---|
| `ccprovider add` | set up a profile (and install it as a command) |
| `ccprovider ls` | list profiles and their state |
| `ccprovider use <name> [-m tier]` | launch Claude Code |
| `ccprovider edit <name>` | change models, key, endpoint, or MCP servers |
| `ccprovider rename <old> <new>` | rename a profile, its key, its history, and its command |
| `ccprovider rm <name>` | delete a profile, its key, its history, and its command |
| `ccprovider install [name]` | make a profile a command (all profiles if no name) |
| `ccprovider uninstall [name]` | remove a command |
| `ccprovider doctor [name]` | check everything, end to end |
| `ccprovider env <name>` | print the exports it would set |

`add` and `edit` take `--refresh` to bypass the 24-hour model-list cache. `add` takes
`--no-install` to skip installing the command. `-y` skips confirmation prompts.

`-m` takes a tier (`opus`, `sonnet`, `haiku`) or a raw provider model ID. Anything after
`--` goes straight to `claude`:

```bash
ccprovider use deepseek -m haiku -- --resume
```

`doctor` sends a real one-token request through **every** alias slot, which is the fastest
way to find an unmapped tier. It also checks the parts around the request:

```
glm  https://api.z.ai/api/anthropic
  ✓ claude on PATH
  ✓ shared config links      5/7 linked to ~/.claude
  ✓ model tier mapping       opus, sonnet, haiku and subagent all mapped
  ✓ API key (macOS Keychain) present
  ✓ command `glm`            ~/.local/bin/glm
  ✓ settings.json overrides  sets none of the variables ccprovider manages
  ✓ MCP web-search-prime     Web search
  ✓ MCP zread                Zread
  ✓ endpoint format          speaks Anthropic Messages
  ✓   opus -> glm-5.3        resolves
  ✓   haiku -> glm-5.2       resolves
```

## Profiles as commands

`ccprovider add` installs the profile as a command of the same name, so `glm` starts
Claude Code against GLM from any shell, and everything you type after it goes to `claude`:

```bash
glm
glm --resume
glm -p "summarise this repo"
```

The command is a three-line `/bin/sh` script in `~/.local/bin`. It holds no key and no
configuration — it runs `ccprovider use glm -- "$@"`, and that is the one place that
reads your key and builds the environment. Because it is plain `sh`, it works the same
from bash, zsh and fish.

`~/.local/bin` has to be on your `PATH` (Claude Code installs itself there too, so it
usually is). If it isn't, `add` and `doctor` say so and print the line to add. Nothing
edits your shell profile for you.

The commands are careful about what they touch:

- **They never overwrite a file they didn't write.** If `~/.local/bin/kimi` is a real
  program, a profile named `kimi` is still fine — it just isn't installed as a command,
  and `ccprovider install kimi` tells you why. Only files carrying ccprovider's marker
  are ever replaced or deleted, and a symlink is never treated as one of them.
- **`add` steps aside for a real program.** If a profile is called `gemini` and a real
  `gemini` is already on your `PATH`, a launcher would silently turn that program into
  Claude Code. So the automatic install skips it and says so; asking by name
  (`ccprovider install gemini`) is taken as intent, and it tells you what it now stands
  in front of.
- **A few names can never be commands:** `claude`, `ccprovider`, `which`, `security`,
  `secret-tool`, `node` and `npx` — the programs ccprovider itself looks up on `PATH`. A
  launcher with one of those names would be found first and call itself forever.
- **`doctor` notices** a command whose binary has moved, one that another program
  shadows earlier on `PATH`, and leftovers from a deleted profile.

`-m` isn't available through the command (the command owns your arguments). For a
one-off tier, use `ccprovider use glm -m haiku`.

## Renaming a profile

```bash
ccprovider rename zclaude glm
```

A profile's name is four things at once: its entry in `providers.json`, its directory
(which holds the session history), the account its key is filed under, and its command.
`rename` moves all four together. Each step can be undone, and the config write is the
commit point — if anything fails before it, the previous state is restored and nothing is
half-renamed.

Close any running sessions in the old profile first: they keep using the old directory.
Python virtualenvs some tools create inside a profile embed absolute paths and stop
working after the move; `rename` lists any it finds. They are rebuilt on demand, so
deleting them is safe.

## GLM MCP tools

Z.ai ships four MCP servers to GLM Coding Plan subscribers. When you set up the GLM
preset, `add` offers all of them, ticked:

| server | what it does |
|---|---|
| `zai-mcp-server` | image, screenshot, diagram and video analysis (runs `npx @z_ai/mcp-server`) |
| `web-search-prime` | web search |
| `web-reader` | fetch a page as title, text, metadata and links |
| `zread` | search and read GitHub repositories |

They're registered inside the profile's own Claude config, so they exist for `glm` and
nowhere else. `ccprovider edit glm` changes the selection, and `doctor` confirms they are
registered as expected. Both the international (`api.z.ai`) and mainland
(`open.bigmodel.cn`) endpoints are supported; a custom gateway gets none, since it has no
MCP hosts of its own.

**Your key is not written into that config.** The obvious ways to authenticate both go
wrong: writing `Bearer <key>` into `~/.claude.json` leaves the key in a plaintext file,
and `Bearer ${ANTHROPIC_AUTH_TOKEN}` in a remote server's headers is read by Claude Code
as *empty* — silently, so the server just answers 401. Instead each HTTP server uses a
`headersHelper` that reads the token from the session environment on every connection,
and refuses any value outside a plain token alphabet rather than splicing it into JSON.

The vision server runs code from npm with your key in its environment, so its version is
**pinned** in the preset rather than left to whatever npm serves next. It needs Node 22+
(Z.ai's requirement); `doctor` checks. The header helper accepts keys made of letters,
digits and `. _ ~ + / = -`, which covers Z.ai's; `doctor` says so if yours falls outside.

If you later point the profile at a different endpoint, `ccprovider edit` removes the
servers instead of leaving them registered: they would keep sending the profile's key to
the old host, and `doctor` reports any that remain.

> **If you also use Z.ai's `coding-helper`:** it writes `ANTHROPIC_BASE_URL` and
> `ANTHROPIC_AUTH_TOKEN` into `~/.claude/settings.json`, which every profile links to.
> Claude Code applies a settings file's `env` **over** the environment ccprovider builds,
> so that would point every profile at Z.ai. `doctor` flags this as a failure.

## Providers

Built-in presets: **DeepSeek**, **OpenRouter**, **Kimi/Moonshot**, **GLM/Z.ai**,
**MiniMax**, and Custom for LiteLLM, llama.cpp, or a self-hosted gateway. Every base URL
was verified against the live API, and the wizard fetches the provider's current model
list with your key — so a preset that goes stale corrects itself at setup time.

OpenRouter gets the richest treatment: its catalog is public and carries per-model
context length, output caps, tool support, vision support, and pricing, all shown in a
searchable picker.

### OpenAI-compatible endpoints

Not supported directly, by design. Claude Code needs the Anthropic Messages format;
translating between the two means owning streaming reassembly, tool-call mapping and
thinking-block conversion forever. If you have an OpenAI-only endpoint, front it with
LiteLLM and point `ccprovider` at that:

```bash
litellm --model openai/YOUR_MODEL --api_base https://your-endpoint/v1
ccprovider add   # base URL: http://localhost:4000
```

`ccprovider add` detects OpenAI-format URLs and prints this rather than saving something
that can't work.

## Where things live

| | |
|---|---|
| profiles | `~/.config/ccprovider/providers.json` |
| API keys | macOS Keychain · libsecret on Linux · encrypted file as fallback |
| profile dirs | `~/.local/share/ccprovider/dirs/<name>/` |
| commands | `~/.local/bin/<name>` (override with `CCPROVIDER_BIN_DIR`) |
| MCP servers | inside each profile dir, in its own `.claude.json` |
| model cache | `~/.cache/ccprovider/` |

Keys are never written to `providers.json`, to a command, or to an MCP config. The
encrypted-file fallback (headless Linux with no keyring) uses AES-256-GCM with a `0600`
key file — that keeps secrets out of backups and synced dotfiles, but anything running as
your user can read it. `doctor` tells you which backend is in use.

One known limit: on macOS the Keychain entry is written by calling `security
add-generic-password`, which takes the secret as an argument, so it is visible to other
processes of your user in `ps` for the moment that call runs. That happens when a key is
stored (`add`, `edit`, `rename`) — rare, and interactive. Launching a profile reads the
key back through a pipe, not an argument.

Profile names are lowercased. macOS and Windows filesystems are case-insensitive, so
`DeepSeek` and `deepseek` would otherwise share one config directory while being two
separate entries.

## Requirements

macOS or Linux (arm64 or x64, including WSL), and Claude Code on your `PATH`. Nothing
else: the release binary bundles its runtime. Bun is only needed to build from source.
Native Windows isn't supported: the profile directories and commands rely on POSIX
symlinks and `/bin/sh`.

## Is this allowed?

Yes. `ANTHROPIC_BASE_URL` is a documented Claude Code feature intended for gateways, and
providers like DeepSeek and OpenRouter document Claude Code as a client of their
Anthropic-compatible endpoints. In this mode no request reaches Anthropic.

Don't do the reverse — piping Claude subscription credentials into third-party tools is
what actually violates the terms.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) — it also explains how to probe a provider's
endpoint before proposing a preset. Report vulnerabilities privately, as described in
[SECURITY.md](SECURITY.md), not in a public issue.

## License

[MIT](LICENSE). The release binaries bundle the Bun runtime and a few npm packages; their
notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), which ships with every
release.
