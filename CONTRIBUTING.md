# Contributing

```bash
bun install             # installs from the lockfile, and builds dist/ (the `prepare` script)
bun test
bun run typecheck
bun run dev ls          # run from source, no build step
bun run build           # tsc -> dist/, the package that is published
```

Bun is the development toolchain: it runs the tests and owns the lockfile. What ships is
plain JavaScript built by `tsc`, and it runs on Node 20.11+ with no Bun involved — CI's
`node-compat` job proves that by installing the packed tarball, and a git checkout, under
Node 20, 22 and 24 and running them. If you reach for a `Bun.*` API in `src/`, that job
is what will stop you; `test/` may use anything.

`bun install` and `npm install` both run `prepare`, which builds `dist/`. That is what makes
a plain clone usable before the package is on npm: `npm install && npm link`, or
`node dist/cli.js`. (`npm install -g github:...` is deliberately not offered: npm's global
git installs skip devDependencies, so `tsc` is not there to run `prepare`.)

npm ignores `bun.lock` and resolves the newest matching dependencies, so a user's clone can
differ from what the tests ran against — that is how @clack/prompts 1.8 broke the build the
first time this was tried. CI's `fresh-install` job does exactly what a user does, on
purpose, so upstream drift shows up there rather than in an issue.

Dependencies are updated by hand (`bun update`); Dependabot only keeps the workflow actions'
commit-SHA pins current.

## Layout

| | |
|---|---|
| `src/launch.ts` | `buildEnv()` — the heart. Pure, exhaustively tested. |
| `src/configdir.ts` | profile dirs and symlink reconciliation |
| `src/shim.ts` | the per-profile launcher commands in `binDir`, the ownership rules around them, and how a launcher points back at this install |
| `src/rename.ts` | transactional profile rename (undo stack; the config write is the commit point) |
| `src/mcp.ts` | provider MCP servers: definitions, authentication, syncing into a profile |
| `src/catalog.ts` | provider model lists and capability filtering |
| `src/probe.ts` | endpoint format detection, per-model probes |
| `src/presets.ts` | the provider catalog |
| `src/doctor.ts` | the checks behind `ccprovider doctor` |
| `src/tui/` | the `add`/`edit` wizard |

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
`CHANGELOG.md` under it, commit to `main`, then `git tag -a vX.Y.Z -m ccprovider X.Y.Z &&
git push origin vX.Y.Z`. The release workflow refuses a tag that isn't `package.json`'s
version or isn't on `main`, runs the tests, packs the package, proves the tarball installs
and runs under Node, attests its provenance, and creates the GitHub release with the
tarball attached. A tag with a hyphen (`v0.2.0-rc.1`) is a pre-release, and goes to npm
under the `next` dist-tag.

**Publishing to npm** is the last step of that workflow, and it only runs when the
repository has an `NPM_TOKEN` secret. Until it does, a release lives on GitHub only and is
installable by URL. To turn it on:

1. Create the package's owner on npm (the `ccprovider` name was unclaimed when this was
   written), and a granular access token with publish rights to it.
2. Add it as the `NPM_TOKEN` repository secret.
3. Tag the next release — or re-run the last release workflow, which publishes the same
   tarball it already attested.

npm records where each version came from (`--provenance`), so `npm audit signatures`
verifies installs from the registry.
