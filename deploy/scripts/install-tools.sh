#!/usr/bin/env bash
# Downloads pinned infra linters into a tools directory (default: $TMPDIR/switchyard-tools),
# verifying each archive against the checksum file published with its release.
#   deploy/scripts/install-tools.sh [dir]
# Tools: promtool (Prometheus), kubeconform, actionlint, tflint, gitleaks. Linux/macOS, amd64/arm64.
set -euo pipefail

PROMETHEUS_VERSION=3.15.1
KUBECONFORM_VERSION=0.8.0
ACTIONLINT_VERSION=1.7.12
TFLINT_VERSION=0.65.0
GITLEAKS_VERSION=8.30.1

DIR="${1:-${TMPDIR:-/tmp}/switchyard-tools}"
mkdir -p "$DIR"
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$(uname -m)" in
  x86_64 | amd64) ARCH=amd64 ;;
  aarch64 | arm64) ARCH=arm64 ;;
  *) echo "unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac

sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }

# fetch <url> <checksums-url> <asset-name> → downloads to $TMP/<asset-name> and verifies it
fetch() {
  local url="$1" sums="$2" asset="$3"
  curl -fsSL -o "$TMP/$asset" "$url"
  local want
  want="$(curl -fsSL "$sums" | awk -v a="$asset" '$2 == a || $2 == "*"a {print $1}')"
  [ -n "$want" ] || { echo "no checksum for $asset" >&2; exit 1; }
  [ "$(sha256 "$TMP/$asset")" = "$want" ] || { echo "checksum mismatch for $asset" >&2; exit 1; }
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if ! "$DIR/promtool" --version 2>/dev/null | grep -q "version $PROMETHEUS_VERSION"; then
  a="prometheus-${PROMETHEUS_VERSION}.${OS}-${ARCH}.tar.gz"
  base="https://github.com/prometheus/prometheus/releases/download/v${PROMETHEUS_VERSION}"
  fetch "$base/$a" "$base/sha256sums.txt" "$a"
  tar -xzf "$TMP/$a" -C "$TMP"
  install -m 0755 "$TMP/prometheus-${PROMETHEUS_VERSION}.${OS}-${ARCH}/promtool" "$DIR/promtool"
fi

if ! "$DIR/kubeconform" -v 2>/dev/null | grep -q "v$KUBECONFORM_VERSION"; then
  a="kubeconform-${OS}-${ARCH}.tar.gz"
  base="https://github.com/yannh/kubeconform/releases/download/v${KUBECONFORM_VERSION}"
  fetch "$base/$a" "$base/CHECKSUMS" "$a"
  tar -xzf "$TMP/$a" -C "$TMP" kubeconform
  install -m 0755 "$TMP/kubeconform" "$DIR/kubeconform"
fi

if ! "$DIR/actionlint" -version 2>/dev/null | grep -q "^$ACTIONLINT_VERSION"; then
  a="actionlint_${ACTIONLINT_VERSION}_${OS}_${ARCH}.tar.gz"
  base="https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}"
  fetch "$base/$a" "$base/actionlint_${ACTIONLINT_VERSION}_checksums.txt" "$a"
  tar -xzf "$TMP/$a" -C "$TMP" actionlint
  install -m 0755 "$TMP/actionlint" "$DIR/actionlint"
fi

if ! "$DIR/tflint" --version 2>/dev/null | grep -q "version $TFLINT_VERSION"; then
  a="tflint_${OS}_${ARCH}.zip"
  base="https://github.com/terraform-linters/tflint/releases/download/v${TFLINT_VERSION}"
  fetch "$base/$a" "$base/checksums.txt" "$a"
  (cd "$TMP" && unzip -q -o "$a" tflint)
  install -m 0755 "$TMP/tflint" "$DIR/tflint"
fi

if ! "$DIR/gitleaks" version 2>/dev/null | grep -q "$GITLEAKS_VERSION"; then
  case "$ARCH" in amd64) GL_ARCH=x64 ;; *) GL_ARCH=arm64 ;; esac
  a="gitleaks_${GITLEAKS_VERSION}_${OS}_${GL_ARCH}.tar.gz"
  base="https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}"
  fetch "$base/$a" "$base/gitleaks_${GITLEAKS_VERSION}_checksums.txt" "$a"
  tar -xzf "$TMP/$a" -C "$TMP" gitleaks
  install -m 0755 "$TMP/gitleaks" "$DIR/gitleaks"
fi

echo "tools in $DIR: promtool $PROMETHEUS_VERSION, kubeconform $KUBECONFORM_VERSION, actionlint $ACTIONLINT_VERSION, tflint $TFLINT_VERSION, gitleaks $GITLEAKS_VERSION"
