#!/usr/bin/env bash
#
# Regenerates flatpak/generated-sources.json from package-lock.json.
#
# Flathub builds with no network, so every byte the build needs has to be
# declared as a source with a checksum: ~630 npm tarballs, and the Electron
# binary, laid out as the cache @electron/get expects. flatpak-node-generator
# derives all of it from the lockfile — including the right `only-arches` per
# platform package, so an x86_64 build does not drag down the arm64 Electron.
#
# Run this whenever package-lock.json changes. CI does it too, and opens a pull
# request if the result differs — the failure mode otherwise is silent: the
# Flatpak keeps building against the dependency tree of two commits ago.
#
#   ./scripts/generate-flatpak-sources.sh
#
# Needs python3 and network access. Nothing is installed system-wide; the
# generator lives in a throwaway virtualenv.

set -euo pipefail

# Pinned rather than tracking main: this tool decides the exact bytes that go
# into a release build, and an unannounced change in its output is not something
# a diff of our own source would ever show. Bump deliberately.
UPSTREAM_COMMIT=737c0085912f9f7dabf9341d4608e2a77a51a73a
UPSTREAM_REPO=https://github.com/flatpak/flatpak-builder-tools.git

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT="$ROOT/flatpak/generated-sources.json"

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

echo "Fetching flatpak-node-generator at ${UPSTREAM_COMMIT:0:12}…"
git -C "$WORKDIR" init -q .
git -C "$WORKDIR" remote add origin "$UPSTREAM_REPO"
git -C "$WORKDIR" fetch -q --depth 1 origin "$UPSTREAM_COMMIT"
git -C "$WORKDIR" checkout -q FETCH_HEAD

python3 -m venv "$WORKDIR/venv"
"$WORKDIR/venv/bin/pip" install -q --disable-pip-version-check "$WORKDIR/node"

echo "Generating sources from package-lock.json…"
"$WORKDIR/venv/bin/flatpak-node-generator" npm "$ROOT/package-lock.json" -o "$OUTPUT"

echo "Wrote $OUTPUT ($(python3 -c "import json,sys; print(len(json.load(open('$OUTPUT'))))") entries)"
