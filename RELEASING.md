# Releasing

Versions are tags. Everything after the tag is CI.

## Cutting a release

1. **Write the changelog entry first.** `CHANGELOG.md` is the single source for the GitHub release notes, the AppStream `<releases>` block, *and* the update notice inside the launcher itself, so an entry that is missing or thin is visible in GNOME Software — and on somebody's television — for as long as the release exists. CI refuses to publish a version with no `## [x.y.z]` section.

   The launcher reads it through `summariseNotes`, which takes the **first four bullets** and, for each, the **bold lead** when that lead is long enough to stand as a sentence. So write the lead as one: `**Starting a game no longer minimises the launcher**, and the setting is gone with it.` is what a user reads at three metres. A short bold lead is treated as a label and the whole line is used instead, which is correct for `**Recent**, a chronology of what you played.` but means the sentence after it had better say something.

2. **Update the AppStream release block** in `flatpak/io.github.robertotucci.GfnLauncher.metainfo.xml` to match, with the date you are actually releasing on.

3. **Bump and tag:**

   ```bash
   npm version <patch|minor|major>   # writes package.json + package-lock, creates the tag
   git push --follow-tags
   ```

4. Watch [Actions](https://github.com/robertotucci/gfnlauncher/actions). The `Release` workflow verifies, builds the AppImage, the `.deb` and the `.flatpak` bundle, and publishes them.

CI checks that the tag matches `package.json` before building anything, because a mismatch produces artefacts named after one version and release notes taken from another — and only whoever downloads them finds out.

## Before tagging

The suite cannot reach the parts that matter most on a couch. On real hardware:

- A pad moves focus, and the footer legend matches the pad in your hands.
- A game launches, and launches a *second* time in the same session — the second one exercises the kill-and-respawn path, which is the normal case from the second launch onwards.
- The Status screen names your datacenter.
- The autostart toggle writes an entry that survives a session restart.
- Power actions work, and a refused one shows the refusal.

And, if anything in `flatpak/` or `src/main/host.ts` changed, the same five inside the Flatpak — that is where they behave differently:

```bash
npm run flatpak:build
flatpak run io.github.robertotucci.GfnLauncher
```

## After a dependency change

```bash
npm run flatpak:sources
```

The Flatpak build is offline; `flatpak/generated-sources.json` is the only thing that decides which dependency bytes reach it. Out of date, it does not fail — it builds happily against an older tree. CI regenerates it on every lockfile change and opens a pull request when it moves, and the CI Flatpak job is the check that catches the rest.

## What the update notice needs from a release

The launcher's own updater reads `/releases/latest` and acts on what it finds there, so two properties of the published release are load-bearing:

- **Every asset needs its sha256 digest**, which GitHub attaches on its own. The AppImage path refuses to install an artefact whose digest is missing or malformed rather than trusting the bytes, so a release published some other way — by hand, or through a tool that strips it — reaches AppImage users as "install it yourself" rather than as an update.
- **The tag must parse as semver**, and pre-releases must actually be marked as such. `/releases/latest` excludes them, and `isNewerVersion` refuses to offer one over the stable version it precedes — but only if the flag is set on the release.

## Flathub

The `.flatpak` bundle in each release installs the same build, but does not update itself. Flathub is the channel that does — and it is what the launcher's own "Install the update" runs against: `flatpak update` needs a remote, so a copy installed from the bundle by hand has nothing to update from and the notice says so instead of pretending.

Submission is a pull request against [`flathub/flathub`](https://github.com/flathub/flathub) on the `new-pr` branch, carrying the manifest with its `type: dir` source replaced by a git source pinned to the release tag. After acceptance, updates are a pull request against the app's own Flathub repository, and the buildbot publishes.

```bash
node scripts/make-flathub-manifest.mjs
flatpak run --filesystem="$PWD" --command=flatpak-builder-lint org.flatpak.Builder \
  manifest release/flathub/io.github.robertotucci.GfnLauncher.yml
```

That writes three files into `release/flathub/`, which are the three the pull request carries at the repository root: the manifest, `flathub.json` — where `only-arches` lives, because flatpak-builder rejects it at manifest top level — and `generated-sources.json`, which the manifest includes by a path relative to itself and therefore has to travel beside it. The tag has to be pushed first: the script checks it against `origin` rather than trusting a local one, because a tag that exists only on this disk builds here and 404s on the buildbot.

**The pull request template's checklist is not optional.** A bot closes the submission within the minute if a single box is unticked, and one of the boxes is a video of the application running from the Flatpak. It also asks you to comment rather than open a replacement, so a closed submission is recovered by completing the description and saying so underneath, not by starting again.

The lint above is expected to fail, with four errors — `finish-args-flatpak-spawn-access` and the three `com.nvidia.geforcenow` folder permissions. They are not defects to fix; they are what the launcher is, and Flathub grants them as exceptions during review. The pull request has to argue each one, and the arguments are the comments beside the permissions in the manifest, which is why the swap above preserves them.

Expect the review to ask about `--talk-name=org.freedesktop.Flatpak`. The answer is in the manifest beside the permission: there is no portal for "run this Flatpak with these arguments", the GeForce NOW deep link is an argv rather than a URI scheme, and stopping an already-running client — which is not optional, because a running client silently swallows the link — needs the host as well. It is also the only host permission asked for; the autostart entry deliberately goes through it rather than adding a second.
