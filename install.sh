#!/bin/sh
#
# Install EmPo as a standalone binary.
#
#   curl -fsSL https://raw.githubusercontent.com/W1-PopelierE/empo/main/install.sh | sh
#
# Environment:
#
#   EMPO_INSTALL_DIR   where to put the binary. Default $HOME/.local/bin. Never a system prefix,
#                      so it never asks for elevated privileges and never needs them.
#   EMPO_VERSION       install this exact release tag (for example v0.1.0) instead of the latest.
#
# Flags:
#
#   --help             print this usage and exit.
#   --print-target     print the asset name this machine resolves to and exit, touching no network.
#                      A diagnostic for "which of the four builds am I", and the seam the test suite
#                      uses to exercise the uname mapping without downloading anything.
#
# ---------------------------------------------------------------------------------------------
#
# Why this is the only channel, rather than one of two.
#
# npm's global prefix is per Node version. Install `empo` globally under Node 22 and it lives in that
# version's prefix; the moment a repository pins Node 21 and the version manager switches, the prefix
# switches with it and `empo` is simply not on PATH any more. That is not a hypothetical for this
# tool in particular: EmPo runs from hooks inside other people's repositories, which is precisely the
# place where a version switch has just happened, and a hook that fails open reports nothing rather
# than reporting that it is missing. The failure is silent by design, so it is the failure worth
# removing at the source.
#
# A fixed path does not move. $HOME/.local/bin belongs to the user and not to a toolchain, so a
# binary placed there answers to every repository on the machine regardless of which interpreter that
# repository asked for. The binary carries its own interpreter, so there is nothing left to resolve.
#
# npm was considered as a second channel and dropped, so nothing here is a fallback to it. It would
# have been defensible for a terminal you control and for CI, where the Node version is pinned by the
# workflow and does not move underneath you. It was dropped because EmPo is language-agnostic and npm
# is one language's package manager, because nothing had ever been published so there was no
# deprecation to perform, and because two install routes is one more than a tool this size can keep
# honest. package.json carries `private: true` and the packaging machinery is deleted rather than
# left dormant, so the decision is written down in the tree and not only in somebody's memory.
#
# ---------------------------------------------------------------------------------------------

set -eu

REPO="W1-PopelierE/empo"
API="https://api.github.com/repos/${REPO}/releases/latest"

log() {
  printf '%s\n' "$*"
}

fail() {
  printf 'empo install: %s\n' "$*" >&2
  exit 1
}

# Written out rather than read back out of the comment block above with sed. Piped into `sh` this
# script has no file to read: $0 is the shell, and a usage that prints nothing under the one
# invocation the README documents is worse than a duplicated paragraph.
usage() {
  cat <<'USAGE'
Install EmPo as a standalone binary.

  curl -fsSL https://raw.githubusercontent.com/W1-PopelierE/empo/main/install.sh | sh

Environment:

  EMPO_INSTALL_DIR   where to put the binary. Default $HOME/.local/bin. Never a system prefix,
                     so it never asks for elevated privileges and never needs them.
  EMPO_VERSION       install this exact release tag (for example v0.1.0) instead of the latest.

Flags:

  --help             print this usage and exit.
  --print-target     print the asset name this machine resolves to and exit, touching no network.
USAGE
}

# Map `uname` output onto the asset names CI publishes. The four names here are the whole contract
# with .github/workflows/ci.yml, which builds exactly `empo-<platform>-<arch>` for the four pairs
# below; test/install-script.test.ts pins the two lists against each other, because a platform added
# to one and not the other is silent in both directions.
detect_target() {
  uname_s=$(uname -s)
  uname_m=$(uname -m)

  case "$uname_s" in
    Darwin) platform=darwin ;;
    Linux) platform=linux ;;
    *) platform="" ;;
  esac

  # x86_64 and amd64 are the same machine under two names, as are aarch64 and arm64. Normalising
  # here rather than at the call site keeps the asset name the single spelling anybody has to know.
  case "$uname_m" in
    x86_64 | amd64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) arch="" ;;
  esac

  if [ -z "$platform" ] || [ -z "$arch" ]; then
    fail "no build for $uname_s $uname_m.
EmPo publishes four binaries: empo-darwin-arm64, empo-darwin-x64, empo-linux-x64, empo-linux-arm64.
There is no other install route: EmPo is not published to npm, deliberately (docs/10-distribution.md).
To run it here anyway, clone the repository and build it: npm install && npm run build:binary."
  fi

  printf 'empo-%s-%s\n' "$platform" "$arch"
}

# curl or wget, whichever is here. Both are asked to fail loudly on an HTTP error rather than write
# the error page into the file and let the checksum be the thing that catches it.
detect_downloader() {
  if command -v curl >/dev/null 2>&1; then
    printf 'curl\n'
  elif command -v wget >/dev/null 2>&1; then
    printf 'wget\n'
  else
    fail "neither curl nor wget is installed, so there is no way to download anything."
  fi
}

download() {
  # download <url> <destination>
  case "$downloader" in
    curl) curl -fsSL "$1" -o "$2" ;;
    wget) wget -q -O "$2" "$1" ;;
  esac
}

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    fail "neither shasum nor sha256sum is installed.
This script will not install an executable it cannot verify. Install one of them and try again."
  fi
}

# The tag to install. EMPO_VERSION wins outright; otherwise ask GitHub what the latest release is.
# The JSON is split on commas and braces first so the tag_name match cannot run past its own object
# on a response that arrives on one line.
resolve_tag() {
  if [ -n "${EMPO_VERSION:-}" ]; then
    printf '%s\n' "$EMPO_VERSION"
    return
  fi

  body=$(download "$API" /dev/stdout) || fail "could not reach $API. Is the network up?"
  tag=$(
    printf '%s' "$body" |
      tr ',{}' '\n\n\n' |
      sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' |
      head -n 1
  )

  if [ -z "$tag" ]; then
    fail "no published release found at $API.
EmPo becomes installable this way with its first public release. Until then, build from a checkout,
or set EMPO_VERSION to a tag you know exists."
  fi

  printf '%s\n' "$tag"
}

# Where the line goes, for the two shells that cover almost everybody. Printed rather than written:
# this script does not edit a profile it did not create.
profile_for_shell() {
  case "$(basename "${SHELL:-/bin/sh}")" in
    zsh) printf '%s\n' "$HOME/.zshrc" ;;
    bash)
      # On macOS a login shell reads .bash_profile and not .bashrc, and Terminal.app opens login
      # shells, so naming .bashrc alone there sends people to a file that is never read.
      if [ "$(uname -s)" = Darwin ]; then
        printf '%s\n' "$HOME/.bash_profile"
      else
        printf '%s\n' "$HOME/.bashrc"
      fi
      ;;
    *) printf '%s\n' "your shell's startup file" ;;
  esac
}

main() {
  for arg in "$@"; do
    case "$arg" in
      --help | -h)
        usage
        exit 0
        ;;
      --print-target)
        detect_target
        exit 0
        ;;
      *) fail "unknown option $arg. Try --help." ;;
    esac
  done

  asset=$(detect_target)
  downloader=$(detect_downloader)

  install_dir="${EMPO_INSTALL_DIR:-$HOME/.local/bin}"
  mkdir -p "$install_dir" || fail "could not create $install_dir."
  [ -w "$install_dir" ] || fail "$install_dir is not writable.
Set EMPO_INSTALL_DIR to somewhere you own. This script will not escalate privileges."

  tag=$(resolve_tag)
  base="https://github.com/${REPO}/releases/download/${tag}"

  # One temp directory, removed on every exit including a failed one, so a half-downloaded binary
  # never outlives the run that produced it.
  tmp=$(mktemp -d) || fail "could not create a temporary directory."
  trap 'rm -rf "$tmp"' EXIT INT TERM

  log "Installing empo $tag ($asset) into $install_dir"

  download "$base/$asset" "$tmp/$asset" ||
    fail "could not download $base/$asset. Does release $tag publish that asset?"
  download "$base/$asset.sha256" "$tmp/$asset.sha256" ||
    fail "could not download $base/$asset.sha256, so the binary cannot be verified. Nothing installed."

  # `<hex>  <filename>`, the output of `shasum -a 256`. Compared field by field rather than through
  # `shasum -c`, which resolves the filename in the file relative to the working directory and would
  # fail for a reason that has nothing to do with the bytes.
  expected=$(awk '{print $1}' "$tmp/$asset.sha256")
  actual=$(sha256_of "$tmp/$asset")

  if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
    fail "checksum mismatch for $asset.
  expected $expected
  actual   $actual
Nothing has been installed. Do not run the downloaded file."
  fi

  target="$install_dir/empo"
  # Into place in one move, over any binary already there. A rename over a running executable is
  # fine on macOS and Linux: the running process keeps the inode it started from.
  mv -f "$tmp/$asset" "$target" || fail "could not write $target."
  chmod 755 "$target"

  log "Verified sha256 $actual"
  log "Installed $target"

  case ":$PATH:" in
    *":$install_dir:"*) ;;
    *)
      profile=$(profile_for_shell)
      log ""
      log "$install_dir is NOT on your PATH, so \`empo\` will not be found yet."
      log "Add this line to $profile:"
      log ""
      log "  export PATH=\"$install_dir:\$PATH\""
      log ""
      log "Then open a new terminal, or run: export PATH=\"$install_dir:\$PATH\""
      log ""
      ;;
  esac

  # Running it is the only proof that the right binary landed on the right machine. A wrong
  # architecture downloads and verifies perfectly and then refuses to execute.
  "$target" --version || fail "$target was installed but does not run on this machine."
}

main "$@"
