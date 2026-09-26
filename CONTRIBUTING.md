# Contributing

```bash
bun install
bun test
bun run typecheck
bun run dev ls          # run from source, no build step
bun run build           # -> dist/ccprovider, a self-contained binary
bun run install:local   # build, then install to ~/.local/bin/ccprovider
```

Bun is the toolchain and the runtime: the shipped artifact is a binary produced by
`bun build --compile`, so users need neither Bun nor Node. `bun run build:all`
cross-compiles all four release targets (macOS and Linux, arm64 and x64) from one machine
and writes `dist/SHA256SUMS`; CI runs it on every push, so a target that stops
compiling is caught before a release.

`src/` still imports only `node:*` builtins, not `Bun.*`. That is a habit kept for its own
sake now — it keeps the modules testable with plain injected functions and portable — not
a compatibility requirement, so if a `Bun.*` API is genuinely the right tool, say why in
the pull request. `test/` and `scripts/` may use anything.

Things that only go wrong in a *compiled* binary are guarded in CI's `build` job. The
one already found: a binary has no `package.json` beside it, so anything that reads it at
runtime silently reports a wrong version. `src/cli.ts` imports it instead.

When you add or upgrade a runtime dependency, run `bun run notices` and commit the result:
the binary bundles it, and its license requires the notice to travel along. CI regenerates
the file and fails if it differs.

## Layout

| | |
|---|---|
| `src/launch.ts` | `buildEnv()` — the heart. Pure, exhaustively tested. |
| `src/configdir.ts` | profile dirs and symlink reconciliation |
| `src/shim.ts` | the per-profile launcher commands in `binDir`, and the ownership rules around them |
| `src/rename.ts` | transactional profile rename (undo stack; the config write is the commit point) |
| `src/mcp.ts` | provider MCP servers: definitions, authentication, syncing into a profile |
| `src/catalog.ts` | provider model lists and capability filtering |
| `src/probe.ts` | endpoint format detection, per-model probes |
| `src/presets.ts` | the provider catalog |
| `src/doctor.ts` | the checks behind `ccprovider doctor` |
| `src/tui/` | the `add`/`edit` wizard |
| `scripts/build-release.ts` | cross-compile the release binaries and write checksums |
| `scripts/notices.ts` | regenerate `THIRD_PARTY_NOTICES.md` from the bundled dependencies |
| `install.sh` | the installer; tested against a local `file://` release in `test/install.test.ts` |

## Rules

**`buildEnv()` stays pure.** No I/O, no `process.env` reads inside it. Every behaviour it
has should be assertable in a table test.

**`removeProfileDir()` never follows a symlink.** A profile directory is mostly links into
the user's real `~/.claude`. `test/configdir.test.ts` has a test named
`THE SAFETY TEST` that builds a populated fake config, links a profile at it, removes the
profile, and asserts every original file survived. Don't weaken it.

**Only ever touch a launcher ccprovider wrote.** `binDir` is the user's own `PATH`
directory and holds real programs. `shim.ts` decides ownership from a marker line in a
small regular file, never treats a symlink as ours, and creates new launchers with
`link(2)` so a file that appears between the check and the write is never replaced. Every
install, remove and rename path goes through it; don't add one that bypasses it.

**The API key never goes into a file, a launcher, an MCP config, or an argument.** It
lives in the secret store and reaches a process through its environment. MCP servers get
it through `headersHelper` and `${ANTHROPIC_AUTH_TOKEN}` references — not literally, and
not through `${...}` in a remote server's `headers`, which Claude Code reads as empty.
`test/mcp.test.ts` asserts that no generated definition contains a key.

**A rename either finishes or restores.** Each step has an undo, and `saveStore` is the
commit point. New steps go in the undo stack, and get a rollback test.

## Context windows

A preset needs `contextTokens` (the model's true window) as well as `autoCompactWindow`
(where compaction fires, conventionally 75% of it). Claude Code assumes 200k for any
model ID it does not recognise, so omitting `contextTokens` silently truncates the model.
You can see it decide: run `claude --print hi` through a profile and watch for
`[claude-code:unrecognized_model]`.

## Adding a provider preset

Add an entry to `src/presets.ts` with a base URL you have actually probed — and probe
it with a **control path**, because a bare 401 proves nothing:

```bash
for path in /v1/messages /v1/__bogus__; do
  printf '%-16s ' "$path"
  curl -s -o /dev/null -w '%{http_code}\n' -X POST \
    "https://your-provider.example/anthropic$path" \
    -H 'content-type: application/json' -d '{}'
done
```

If the bogus path returns something *different* (usually 404) while `/v1/messages`
returns 401/403, the route is real. If both return the same status, the provider
authenticates before routing — DeepSeek does this — and an unauthenticated probe
cannot distinguish a correct URL from a typo. That is what the `inconclusive` verdict
means, and why the wizard follows up with an authenticated `probeModel` call.

A 404 on `/v1/messages` with a live `/chat/completions` means OpenAI-only: that
provider needs a LiteLLM front and isn't a candidate for a preset.

Set `sourced` honestly: `'catalog-inferred'` if you derived the model IDs from a model
list rather than the provider's own Claude Code documentation. Add the preset to the
table test in `test/launch.test.ts`, which asserts every shipped preset fills all four
required slots.

### Providers that ship MCP servers

A preset may carry `mcp` — see the GLM entry. Give each region's exact hosts, verified
against the provider's documentation or its own installer, and say which in a comment with
the date. If a server runs code from a package registry, **pin its version**: that
process is handed the user's API key, so an unpinned `npx` would run whatever is published
next. Note what plan the servers need in `mcp.note`.

## Pull requests

One change per pull request. Bug fixes come with a test that fails without the fix, marked
`// Regression:` and naming what went wrong. The checklist in the pull request template
is the bar: `bun test`, `bun run typecheck`, and `README.md` and the `USAGE` text in
`src/cli.ts` still matching the commands that exist.

## Releases

A release is a tag. Set `version` in `package.json`, move the `[Unreleased]` entries in
`CHANGELOG.md` under it, commit, then `git tag vX.Y.Z && git push --tags`. The release
workflow refuses a tag that doesn't equal `package.json`'s version, builds all four
binaries, attests their provenance, and publishes them with `SHA256SUMS` and
`install.sh`.
