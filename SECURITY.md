# Security policy

## Supported versions

No release has been tagged yet, so there is no supported version to patch — every
security fix lands on `main`, and `main` is the only version anyone should be running.

Once releases exist, this section will name the versions that still receive fixes.

## Reporting a vulnerability

Report privately through GitHub's advisory form:

**<https://github.com/kilaslab/ccprovider/security/advisories/new>**

That channel is visible only to you and the maintainers. Please do not open a public
issue, and do not post it in a discussion or a pull request — an issue is indexed within
minutes and tells everyone what to attack before there is a fix.

If you cannot use GitHub, email **yusrilizzaaulia@gmail.com** with `ccprovider security`
in the subject.

A useful report includes:

- **Version.** The output of `ccprovider --version`.
- **Platform.** macOS or Linux, arm64 or x64, and which secret backend `ccprovider doctor`
  reports (Keychain, libsecret, or the encrypted file).
- **Reproduction.** The smallest sequence that shows the problem.
- **Impact.** What an attacker gains, and what access they need to start.

## What to expect

ccprovider is maintained by one person and pays no bounty. Reports are read and
acknowledged as quickly as possible — days, not hours — and you will be told whether the
report is accepted, what the fix is, and when it ships. If you want credit in the published
advisory, say so and how you would like to be named.

## In scope

The tool's own trust boundaries. A report that defeats one of these is a vulnerability:

- **The API key.** Keys live in the OS secret store and reach a process only through its
  environment. Anything that writes one to a file, a launcher command, an MCP server
  definition or a log, that passes one to `claude` or a child process as an argument, or
  that sends one to a host other than the profile's own endpoint, is in scope. So is any
  path by which a Claude *subscription* credential (`CLAUDE_CODE_OAUTH_TOKEN`, an
  inherited `ANTHROPIC_API_KEY`) could reach a third-party endpoint; `buildEnv` strips
  them and has tests for it.
- **The launcher commands.** ccprovider writes small scripts into `~/.local/bin`. A way to
  make it overwrite or delete a file it did not create, follow a symlink out of that
  directory, or make a script run something other than `ccprovider use <profile>`, is in
  scope. So is command injection through a profile name, a model ID or a path.
- **Profile directories.** `rm` and `rename` operate on `~/.local/share/ccprovider/dirs`.
  Any way to make them touch a path outside it, or to reach the user's real `~/.claude`
  through the symlinks a profile contains, is in scope.
- **MCP provisioning.** Definitions written into a profile's Claude config, how the key
  reaches those servers, and the pinned package a stdio server runs.
- **The installer and release artifacts.** `install.sh` verifying what it installs, and
  the integrity of the published binaries and their attestations.

## Known limitations

These are understood and documented rather than reportable:

- **The macOS Keychain write puts the secret in an argument.** `security
  add-generic-password` takes it as `-w <secret>`, so another process running as the same
  user could read it from `ps` during that call. It happens when a key is stored (`add`,
  `edit`, `rename`), not when a profile is launched.
- **The encrypted-file fallback does not defend against your own user.** It uses AES-256-GCM
  with a `0600` key file beside the vault, which keeps secrets out of backups and synced
  dotfiles. Anything running as you can read the key file too. `doctor` reports when this
  backend is in use.
- **A checksum beside a binary is not a signature.** `install.sh` verifies `SHA256SUMS`,
  which catches corruption and truncation. Detecting a compromised release needs the
  build-provenance attestation: `gh attestation verify <file> --repo kilaslab/ccprovider`.
- **The vision MCP server is third-party code.** `@z_ai/mcp-server` runs with your key in
  its environment. ccprovider pins its version, but it is Z.ai's package.

## Out of scope

Malware already running as your user; a compromised Claude Code installation; the
behaviour, availability or data handling of a model provider or its MCP servers; and
anything that needs you to run a modified copy of ccprovider.
