# ccprovider

Run Claude Code against DeepSeek, OpenRouter, Kimi, GLM, MiniMax, or any other
Anthropic-compatible endpoint — each as a named profile with its own session history,
sharing the skills and plugins you already have.

```bash
npm install -g ccprovider

ccprovider add              # pick a provider, paste a key
ccprovider use deepseek     # launches claude, pointed at DeepSeek
```

No proxy. No request translation. `ccprovider` sets environment variables and `exec`s
the real `claude` binary — nothing sits in the request path.

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
| `ccprovider add` | set up a profile |
| `ccprovider ls` | list profiles and their state |
| `ccprovider use <name> [-m tier]` | launch Claude Code |
| `ccprovider edit <name>` | change models, key, or endpoint |
| `ccprovider rm <name>` | delete a profile, its key, and its history |
| `ccprovider doctor [name]` | check everything, end to end |
| `ccprovider env <name>` | print the exports it would set |

`add` and `edit` take `--refresh` to bypass the 24-hour model-list cache.

`-m` takes a tier (`opus`, `sonnet`, `haiku`) or a raw provider model ID. Anything after
`--` goes straight to `claude`:

```bash
ccprovider use deepseek -m haiku -- --resume
```

`doctor` sends a real one-token request through **every** alias slot, which is the fastest
way to find an unmapped tier:

```
deepseek  https://api.deepseek.com/anthropic
  ✓ claude on PATH
  ✓ shared config links      5/7 linked to ~/.claude
  ✓ model tier mapping       opus, sonnet, haiku and subagent all mapped
  ✓ API key (macOS Keychain) present
  ✓ endpoint format          speaks Anthropic Messages
  ✓   opus -> deepseek-v4-pro[1m]     resolves
  ✓   haiku -> deepseek-v4-flash      resolves
```

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
| model cache | `~/.cache/ccprovider/` |

Keys are never written to `providers.json`. The encrypted-file fallback (headless Linux
with no keyring) uses AES-256-GCM with a `0600` key file — that keeps secrets out of
backups and synced dotfiles, but anything running as your user can read it. `doctor`
tells you which backend is in use.

Profile names are lowercased. macOS and Windows filesystems are case-insensitive, so
`DeepSeek` and `deepseek` would otherwise share one config directory while being two
separate entries.

## Requirements

Node 20.11+, macOS or Linux (including WSL). Native Windows isn't supported: the profile
directories rely on POSIX symlinks.

## Is this allowed?

Yes. `ANTHROPIC_BASE_URL` is a documented Claude Code feature intended for gateways, and
providers like DeepSeek and OpenRouter document Claude Code as a client of their
Anthropic-compatible endpoints. In this mode no request reaches Anthropic.

Don't do the reverse — piping Claude subscription credentials into third-party tools is
what actually violates the terms.

## License

MIT
