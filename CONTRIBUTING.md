# Contributing

```bash
bun install
bun test
npm run build
```

## Layout

| | |
|---|---|
| `src/launch.ts` | `buildEnv()` — the heart. Pure, exhaustively tested. |
| `src/configdir.ts` | profile dirs and symlink reconciliation |
| `src/catalog.ts` | provider model lists and capability filtering |
| `src/probe.ts` | endpoint format detection, per-model probes |
| `src/presets.ts` | the provider catalog |
| `src/tui/` | the `add`/`edit` wizard |

## Two rules

**`buildEnv()` stays pure.** No I/O, no `process.env` reads inside it. Every behaviour it
has should be assertable in a table test.

**`removeProfileDir()` never follows a symlink.** A profile directory is mostly links into
the user's real `~/.claude`. `test/configdir.test.ts` has a test named
`THE SAFETY TEST` that builds a populated fake config, links a profile at it, removes the
profile, and asserts every original file survived. Don't weaken it.

## Context windows

A preset needs `contextTokens` (the model's true window) as well as `autoCompactWindow`
(where compaction fires, conventionally 75% of it). Claude Code assumes 200k for any
model ID it does not recognise, so omitting `contextTokens` silently truncates the model.
You can see it decide: run `claude --print hi` through a profile and watch for
`[claude-code:unrecognized_model]`.

## Adding a provider preset

Add an entry to `src/presets.ts` with a base URL you have actually probed:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  https://your-provider.example/anthropic/v1/messages \
  -H 'content-type: application/json' -d '{}'
```

`401` or `403` means the Anthropic route exists. `404` means it doesn't — that provider
needs a LiteLLM front and isn't a candidate for a preset.

Set `sourced` honestly: `'catalog-inferred'` if you derived the model IDs from a model
list rather than the provider's own Claude Code documentation. Add the preset to the
table test in `test/launch.test.ts`, which asserts every shipped preset fills all four
required slots.
