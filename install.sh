#!/bin/sh
#
# Install EmPo as a standalone binary.
#
#   curl -fsSL https://raw.githubusercontent.com/W1-PopelierE/EmPo/main/install.sh | sh
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

REPO="W1-PopelierE/EmPo"
API="https://api.github.com/repos/${REPO}/releases/latest"

# Colour only when someone is actually watching. Piped into a file, into a CI log, or with NO_COLOR
# set, every variable below collapses to the empty string and the output is the same plain text it
# was before. `--print-target` and the `fail` messages are parsed by test/install-script.test.ts,
# which runs the script with its output piped, so that path is always uncoloured by construction.
if [ -t 1 ]; then tty=1; else tty=0; fi

if [ "$tty" = 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-dumb}" != dumb ]; then
  BOLD=$(printf '\033[1m')
  DIM=$(printf '\033[2m')
  GREEN=$(printf '\033[32m')
  RED=$(printf '\033[31m')
  CYAN=$(printf '\033[36m')
  RESET=$(printf '\033[0m')
else
  BOLD='' DIM='' GREEN='' RED='' CYAN='' RESET=''
fi

log() {
  printf '%s\n' "$*"
}

# A step that is in progress, left open with no newline so its result lands on the same line. The
# trailing spaces cover the tail of a longer line when `step_done` rewrites it from column zero.
step() {
  printf '  %s·%s %s' "$DIM" "$RESET" "$1"
}

step_done() {
  printf '\r  %s✓%s %s\033[K\n' "$GREEN" "$RESET" "$1"
}

fail() {
  printf '\n  %s✗%s empo install: %s\n' "$RED" "$RESET" "$*" >&2
  exit 1
}

# Written out rather than read back out of the comment block above with sed. Piped into `sh` this
# script has no file to read: $0 is the shell, and a usage that prints nothing under the one
# invocation the README documents is worse than a duplicated paragraph.
usage() {
  cat <<'USAGE'
Install EmPo as a standalone binary.

  curl -fsSL https://raw.githubusercontent.com/W1-PopelierE/EmPo/main/install.sh | sh

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

# The binary is north of 100 MB, so downloading it silently reads as a hang: the script printed one
# line and then said nothing at all for a minute, which is indistinguishable from being stuck. This
# hands the terminal to the downloader's own progress meter, which repaints a single line on stderr.
# Only the asset gets it — the checksum file and the releases API response are a few dozen bytes, and
# a bar for them would be noise. Off the terminal it degrades to the quiet download, so a CI log gets
# one line rather than a thousand carriage returns.
download_visible() {
  if [ "$tty" = 0 ]; then
    download "$1" "$2"
    return
  fi

  case "$downloader" in
    curl) curl -fSL --progress-bar "$1" -o "$2" ;;
    # --show-progress is GNU wget 1.16 and newer. Asking first, because an unknown option is a hard
    # error there and would turn a cosmetic feature into a failed install.
    wget)
      if wget --help 2>&1 | grep -q -- '--show-progress'; then
        wget -q --show-progress -O "$2" "$1"
      else
        wget -q -O "$2" "$1"
      fi
      ;;
  esac
}

# Bytes as the size a human would say out loud. Integer arithmetic only: `sh` has no floats, and one
# decimal place is enough to tell 108.2 MB from 12.4 MB.
human_size() {
  bytes=$1
  if [ "$bytes" -ge 1048576 ]; then
    printf '%s.%s MB\n' "$((bytes / 1048576))" "$(((bytes % 1048576) * 10 / 1048576))"
  elif [ "$bytes" -ge 1024 ]; then
    printf '%s KB\n' "$((bytes / 1024))"
  else
    printf '%s B\n' "$bytes"
  fi
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

  # Asking GitHub what the latest release is takes a round trip, and until now that round trip
  # happened before anything at all had been printed. Say what is being waited on, then erase the
  # line once the answer is in — the tag it produced is about to be printed in the header anyway.
  log ""
  step "Resolving latest release"
  tag=$(resolve_tag)
  printf '\r\033[K'

  base="https://github.com/${REPO}/releases/download/${tag}"

  # One temp directory, removed on every exit including a failed one, so a half-downloaded binary
  # never outlives the run that produced it.
  tmp=$(mktemp -d) || fail "could not create a temporary directory."
  trap 'rm -rf "$tmp"' EXIT INT TERM

  target="$install_dir/empo"

  printf '  %sEmPo%s %s%s%s\n' "$BOLD" "$RESET" "$CYAN" "$tag" "$RESET"
  printf '  %s%s → %s%s\n' "$DIM" "$asset" "$target" "$RESET"
  log ""

  download_visible "$base/$asset" "$tmp/$asset" ||
    fail "could not download $base/$asset. Does release $tag publish that asset?"
  # The bar curl just drew is the record of the download, so this line replaces it rather than
  # stacking a second line saying the same thing.
  printf '\r%s✓%s Downloaded %s%s%s\033[K\n' \
    "  $GREEN" "$RESET" "$DIM" "$(human_size "$(wc -c <"$tmp/$asset" | tr -d ' ')")" "$RESET"

  step "Verifying checksum"
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

  # The full hash stays in the failure message above, where somebody comparing it by eye needs every
  # character. On success the first and last eight are enough to recognise it in a release note.
  step_done "Verified ${DIM}sha256 $(printf '%s' "$actual" | cut -c1-8)…$(printf '%s' "$actual" | rev | cut -c1-8 | rev)$RESET"

  step "Installing"
  # Into place in one move, over any binary already there. A rename over a running executable is
  # fine on macOS and Linux: the running process keeps the inode it started from.
  mv -f "$tmp/$asset" "$target" || fail "could not write $target."
  chmod 755 "$target"
  step_done "Installed $DIM$target$RESET"

  # Running it is the only proof that the right binary landed on the right machine. A wrong
  # architecture downloads and verifies perfectly and then refuses to execute. The version it reports
  # is captured rather than left to print itself, so the bare `0.1.3` no longer trails the output
  # with nothing to say what it is.
  step "Checking it runs"
  version=$("$target" --version 2>/dev/null) ||
    fail "$target was installed but does not run on this machine."
  step_done "Ready ${DIM}empo $version$RESET"

  log ""

  # The PATH warning comes after the four ticks rather than in the middle of them, so the thing that
  # needs doing is the last thing on screen instead of something scrolled past by the success lines.
  case ":$PATH:" in
    *":$install_dir:"*)
      printf '  Run %sempo --help%s to get started.\n\n' "$BOLD" "$RESET"
      ;;
    *)
      profile=$(profile_for_shell)
      printf '  %s!%s %s is not on your PATH, so %sempo%s will not be found yet.\n' \
        "$BOLD" "$RESET" "$install_dir" "$BOLD" "$RESET"
      printf '    Add this line to %s%s%s:\n\n' "$BOLD" "$profile" "$RESET"
      printf '      %sexport PATH="%s:$PATH"%s\n\n' "$CYAN" "$install_dir" "$RESET"
      printf '    Then open a new terminal, or run that line here.\n\n'
      ;;
  esac
}

main "$@"
