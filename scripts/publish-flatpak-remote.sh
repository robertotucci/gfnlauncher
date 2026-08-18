#!/usr/bin/env bash
#
# Folds a freshly built Flatpak into the published OSTree repository that
# https://robertotucci.github.io/gfnlauncher/ serves, and signs it.
#
# This is the channel that makes `flatpak update` work. A `.flatpak` bundle is
# a single file with no remote behind it, so a copy installed from one can
# never update itself — the launcher's own update notice says as much rather
# than pretending. Flathub would have been the obvious remote and is not
# available to this project; a static OSTree repository on GitHub Pages does
# the same job, and is what NVIDIA does for the GeForce NOW client itself.
#
#   ./scripts/publish-flatpak-remote.sh BUILD_REPO PAGES_DIR
#
# BUILD_REPO is the repository flatpak-builder --repo wrote. PAGES_DIR is a
# checkout of the published branch, or an empty directory the first time.
# Needs flatpak, ostree, and a secret key already imported into the ambient
# GPG keyring; GPG_KEY_ID names it.

set -euo pipefail

APP_ID=io.github.robertotucci.GfnLauncher
REPO_TITLE='GFN Launcher'
# flatpak-builder's default, since the manifest sets no `branch:`. Named here
# so that the repository advertises the same one it actually carries — without
# it, `flatpak install gfnlauncher io.github.robertotucci.GfnLauncher` has to
# be told the branch by hand.
DEFAULT_BRANCH=master

BUILD_REPO="${1:?usage: $0 BUILD_REPO PAGES_DIR}"
PAGES_DIR="${2:?usage: $0 BUILD_REPO PAGES_DIR}"
KEY="${GPG_KEY_ID:?GPG_KEY_ID is not set}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ ! -d "$BUILD_REPO/objects" ]; then
  echo "::error::$BUILD_REPO is not an OSTree repository" >&2
  exit 1
fi

# archive-z2 is the mode for a repository served over plain HTTP: every object
# is stored individually and compressed, so a static file server is the whole
# of the hosting. The bare modes are for local checkouts and need a client that
# can do more than GET.
if [ ! -d "$PAGES_DIR/objects" ]; then
  echo "Initialising a new archive repository in $PAGES_DIR"
  mkdir -p "$PAGES_DIR"
  ostree init --repo="$PAGES_DIR" --mode=archive-z2
fi

# Everything the build produced except the debug symbols, which flatpak-builder
# splits into a .Debug extension of its own. Nobody installs those to play a
# game with a pad, and for an Electron application they are large enough to
# matter against the gigabyte GitHub Pages will serve. Naming the refs rather
# than letting build-commit-from take all of them is the only way to leave one
# behind. .Locale is deliberately *not* filtered: it is an extension flatpak
# installs alongside the application, and dropping it drops translations.
mapfile -t refs < <(ostree --repo="$BUILD_REPO" refs | grep -v '\.Debug/' || true)
if [ ${#refs[@]} -eq 0 ]; then
  echo "::error::$BUILD_REPO has no refs to publish" >&2
  exit 1
fi

# `build-commit-from` rather than `ostree pull-local`, and the difference is
# the whole point of publishing this way. Each CI run builds into an empty
# repository, so its commit has no parent; pulling that across would leave the
# published ref pointing at a commit disconnected from the one before it, and
# a static delta can only be generated between commits that know they are
# related. build-commit-from writes a *new* commit in the destination whose
# parent is whatever was published last, which is what lets the next section
# produce a delta instead of a second full copy.
echo "Committing ${#refs[@]} ref(s) into the published repository"
flatpak build-commit-from \
  --src-repo="$BUILD_REPO" \
  --update-appstream \
  --gpg-sign="$KEY" \
  "$PAGES_DIR" "${refs[@]}"

# --generate-static-deltas is what an existing installation downloads instead
# of the whole application: between two releases of the same Electron version
# almost every object is identical, so the delta is a few megabytes against
# ninety. --prune-depth=1 keeps the current commit and the one before it, which
# is as much history as a delta needs and keeps the published tree inside
# GitHub Pages' one-gigabyte limit.
echo "Generating deltas and pruning"
flatpak build-update-repo \
  --generate-static-deltas \
  --prune \
  --prune-depth=1 \
  --title="$REPO_TITLE" \
  --default-branch="$DEFAULT_BRANCH" \
  --gpg-sign="$KEY" \
  "$PAGES_DIR"

# The one file a user ever types the name of. `flatpak remote-add` reads the
# URL, the title and the signing key out of it, so adding the remote is one
# command with nothing to copy by hand and nothing taken on trust.
echo "Writing the .flatpakrepo"
gpg --export "$KEY" | base64 -w0 > "$PAGES_DIR/.gpgkey.b64"
sed "s|@GPGKEY@|$(cat "$PAGES_DIR/.gpgkey.b64")|" \
  "$ROOT/flatpak/gfnlauncher.flatpakrepo.in" > "$PAGES_DIR/gfnlauncher.flatpakrepo"
rm -f "$PAGES_DIR/.gpgkey.b64"

# GitHub Pages runs Jekyll over a branch unless told not to, which would treat
# an OSTree repository as a site to build and drop anything it does not
# recognise.
touch "$PAGES_DIR/.nojekyll"

echo
echo "Published $(ostree --repo="$PAGES_DIR" refs | tr '\n' ' ')"
echo "Size: $(du -sh "$PAGES_DIR" | cut -f1)"
