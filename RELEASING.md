# Releasing

Versions are tags. Everything after the tag is CI.

## Cutting a release

1. **Write the changelog entry first.** `CHANGELOG.md` is the single source for the GitHub release notes *and* the AppStream `<releases>` block, so an entry that is missing or thin is visible in GNOME Software for as long as the release exists. CI refuses to publish a version with no `## [x.y.z]` section.

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

## Flathub

The `.flatpak` bundle in each release installs the same build, but does not update itself. Flathub is the channel that does.

Submission is a pull request against [`flathub/flathub`](https://github.com/flathub/flathub) on the `new-pr` branch, carrying the manifest with its `type: dir` source replaced by a git source pinned to the release tag. After acceptance, updates are a pull request against the app's own Flathub repository, and the buildbot publishes.

Expect the review to ask about `--talk-name=org.freedesktop.Flatpak`. The answer is in the manifest beside the permission: there is no portal for "run this Flatpak with these arguments", the GeForce NOW deep link is an argv rather than a URI scheme, and stopping an already-running client — which is not optional, because a running client silently swallows the link — needs the host as well. It is also the only host permission asked for; the autostart entry deliberately goes through it rather than adding a second.
