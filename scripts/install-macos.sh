#!/bin/bash
# Installs GhosterAnti for macOS (Apple Silicon) from a GitHub Release.
#   install-macos.sh [--version <version>] [--agent-setup]
# --agent-setup also connects installed AI agent clients and prints the helper's JSON result.
set -euo pipefail

repo="https://github.com/GhosterAI/GhosterAntiApp"
# A local file:// base lets the build pipeline test an unpublished release.
base="${GHOSTERANTI_RELEASE_BASE:-$repo/releases/download}"
version=""
agent_setup=0

fail() {
  echo "GhosterAnti install failed: $1" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) [[ $# -ge 2 ]] || fail "--version needs a value"; version="$2"; shift 2 ;;
    --agent-setup) agent_setup=1; shift ;;
    *) fail "unknown option $1" ;;
  esac
done

[[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" ]] || fail "this installer needs a Mac with Apple Silicon"

if [[ -z "$version" ]]; then
  # The newest release that has a macOS build; the API lists releases newest first.
  version="$(curl -fsSL "https://api.github.com/repos/GhosterAI/GhosterAntiApp/releases?per_page=20" \
    | grep -o 'GhosterAnti_[^"/]*_aarch64\.app\.tar\.gz' | head -n 1 \
    | sed -e 's/^GhosterAnti_//' -e 's/_aarch64\.app\.tar\.gz$//')" || true
  [[ -n "$version" ]] || fail "no macOS release was found"
fi
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || fail "the version is not valid"

applications="/Applications"
[[ -w "$applications" ]] || applications="$HOME/Applications"
app="$applications/GhosterAnti.app"
helper="$app/Contents/MacOS/ghosteranti-mcp"

installed_version() {
  [[ -x "$helper" ]] && "$helper" version 2>/dev/null | sed -n 's/.*"version":"\([^"]*\)".*/\1/p'
}

if [[ "$(installed_version || true)" != "$version" ]]; then
  if pgrep -x ghosteranti >/dev/null; then
    fail "GhosterAnti is open. Quit GhosterAnti, then run this command again"
  fi
  mkdir -p "$applications"
  work="$(mktemp -d "$applications/.ghosteranti-install.XXXXXX")"
  trap 'rm -rf "$work"' EXIT
  archive="GhosterAnti_${version}_aarch64.app.tar.gz"
  curl -fsSL -o "$work/SHA256SUMS-macos.txt" "$base/v$version/SHA256SUMS-macos.txt" \
    || fail "version $version has no macOS build"
  curl -fL --progress-bar -o "$work/$archive" "$base/v$version/$archive" || fail "the download did not complete"
  expected="$(awk -v name="$archive" '$2 == name { print $1 }' "$work/SHA256SUMS-macos.txt")"
  actual="$(shasum -a 256 "$work/$archive" | awk '{ print $1 }')"
  [[ "$expected" =~ ^[0-9a-f]{64}$ && "$actual" == "$expected" ]] || fail "the download did not match its published SHA-256"
  tar -xzf "$work/$archive" -C "$work"
  codesign --verify --deep --strict "$work/GhosterAnti.app" || fail "the downloaded app is damaged"
  rm -rf "$app"
  mv "$work/GhosterAnti.app" "$app"
  rm -rf "$work"
  trap - EXIT
  [[ "$(installed_version || true)" == "$version" ]] || fail "the installed app did not report version $version"
fi

if [[ "$agent_setup" == 1 ]]; then
  exec "$helper" setup --client auto --yes --json
fi
echo "GhosterAnti $version is installed in $applications. Open it from there."
