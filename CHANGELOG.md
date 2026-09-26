# Changelog

All notable changes are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- **Distributed as an npm package again, not as compiled binaries.** A compiled binary is
  the Bun runtime plus about 200 KB of ccprovider (measured: an empty program compiled is
  59 MB, and no compile flag changes that), against a 44 KB package. It needs Node 20.11+.
- **Launchers point at the installed `dist/cli.js`** and let its shebang find `node`, instead of
  baking in the interpreter's path, which changes with every Node version under nvm or fnm.

### Added

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

[Unreleased]: https://github.com/kilaslab/ccprovider/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/kilaslab/ccprovider/releases/tag/v0.1.0
