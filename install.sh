#!/bin/sh
# Install ccprovider: download the release binary for this machine, check it against the
# release's SHA256SUMS, and put it in ~/.local/bin.
#
#   curl -fsSL https://github.com/kilaslab/ccprovider/releases/latest/download/install.sh | sh
#   curl -fsSL .../install.sh | sh -s -- v0.1.0        # a specific version
#
# Environment:
#   CCPROVIDER_INSTALL_DIR   where to install       (default: ~/.local/bin)
#   CCPROVIDER_RELEASE_BASE  where releases live    (default: the GitHub releases page;
#                                                    for mirrors and for testing)
set -eu

REPO="kilaslab/ccprovider"
BASE="${CCPROVIDER_RELEASE_BASE:-https://github.com/$REPO/releases}"
VERSION="${1:-latest}"
DIR="${CCPROVIDER_INSTALL_DIR:-$HOME/.local/bin}"

die() {
  echo "install.sh: $*" >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || die "curl is required"

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) die "unsupported OS: $(uname -s) (macOS and Linux only)" ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) die "unsupported CPU: $(uname -m)" ;;
esac
asset="ccprovider-$os-$arch"

if [ "$VERSION" = "latest" ]; then
  url="$BASE/latest/download"
else
  url="$BASE/download/$VERSION"
fi

# Work inside the destination directory so the final move is a same-filesystem rename:
# atomic, so an interrupted install never leaves a half-written ccprovider behind, and a
# running one is replaced cleanly.
mkdir -p "$DIR"
tmp=$(mktemp -d "$DIR/.ccprovider-install.XXXXXX")
trap 'rm -rf "$tmp"' EXIT INT TERM

echo "Downloading $asset ($VERSION)..."
curl -fsSL "$url/$asset" -o "$tmp/$asset" || die "could not download $url/$asset (is there a release for this version?)"
curl -fsSL "$url/SHA256SUMS" -o "$tmp/SHA256SUMS" || die "could not download $url/SHA256SUMS"

expected=$(awk -v f="$asset" '$2 == f { print $1 }' "$tmp/SHA256SUMS")
[ -n "$expected" ] || die "SHA256SUMS has no entry for $asset"

if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$tmp/$asset" | awk '{ print $1 }')
elif command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$tmp/$asset" | awk '{ print $1 }')
else
  die "need sha256sum or shasum to verify the download"
fi
[ "$expected" = "$actual" ] || die "checksum mismatch for $asset (expected $expected, got $actual) — nothing was installed"

chmod 755 "$tmp/$asset"
# Run it before replacing anything. A binary that verifies but cannot execute here (wrong
# libc, a noexec mount, a CPU it needs more of) must not displace one that works.
ver=$("$tmp/$asset" --version) || die "the downloaded binary does not run on this machine — nothing was installed"
mv -f "$tmp/$asset" "$DIR/ccprovider"

echo "Installed ccprovider $ver to $DIR/ccprovider"
case ":$PATH:" in
  *":$DIR:"*) ;;
  *) echo "Note: $DIR is not on your PATH. Add it, e.g. (bash/zsh):  export PATH=\"$DIR:\$PATH\"" ;;
esac
echo "Next: ccprovider add"
