# Contributing

Thanks for looking. This is a small, opinionated project: a gamepad-only launcher meant to be read from three metres away. Most of the surprising code is surprising for a reason, and [ARCHITECTURE.md](./ARCHITECTURE.md) records those reasons — it is worth skimming before a first change.

## Setup

Requires Node 22 or newer and a gamepad. Linux only.

```bash
npm install
npm run dev
```

A keyboard mirrors the pad for development: arrow keys move, `Enter` is A, `Escape` is B, `/` is search, `Tab` is settings, `F1` is ☰ (play), `[` and `]` are LB/RB. While the search overlay is open, letter keys type.

### A second `npm run dev` looks like it worked and is not

`src/main/index.ts` takes a single-instance lock, so the new Electron builds, quits immediately, and the `second-instance` handler refocuses the *old* window — which is still running the code from before your edits. The tell is `Port 5173 is in use, trying another one`.

Before debugging any "my change did not apply" symptom:

```bash
ps -eo pid,etime,cmd | grep electron-vite
```

An elapsed time older than your edit means you are looking at a stale window, not a bug.

## Commands

```bash
npm run dev            # electron-vite dev server with HMR
npm run build          # typecheck + bundle main/preload/renderer
npm run build:linux    # electron-builder → AppImage + deb into release/
npm run typecheck      # both tsconfigs: node (main+preload) and web (renderer)
npm run lint
npm test               # vitest, single run
npm run test:watch

npx vitest run src/main/gfn/launch.test.ts    # one file
npx vitest run -t 'holds the column'          # one test by name
```

`npx shadcn@latest add <component>` lands in `src/renderer/src/components/ui/` (excluded from lint).

## Building the Flatpak

The Flatpak is the primary distribution, and it is the build most likely to break in ways the others do not — it runs **offline**, so every dependency has to be declared up front, and it runs **sandboxed**, so anything that touches the host goes through `src/main/host.ts`.

One-time setup, no `sudo`, works on any distribution:

```bash
flatpak install --user flathub org.flatpak.Builder
flatpak install --user flathub \
  org.freedesktop.Platform//25.08 org.freedesktop.Sdk//25.08 \
  org.electronjs.Electron2.BaseApp//25.08 org.freedesktop.Sdk.Extension.node24//25.08
```

Then:

```bash
npm run flatpak:build     # build and install locally, ~4 minutes cold
npm run flatpak:lint      # flatpak-builder-lint on the manifest
npm run flatpak:validate  # appstreamcli on the metainfo — CI fails on its warnings
flatpak run io.github.robertotucci.GfnLauncher
```

`flatpak:validate` needs network: `appstreamcli` fetches every screenshot URL to check it resolves. Run it offline and you get five spurious `screenshot-image-not-found` warnings.

**After changing any dependency, regenerate the offline sources:**

```bash
npm run flatpak:sources   # rewrites flatpak/generated-sources.json from package-lock.json
```

Skipping that does not fail loudly. The Flatpak keeps building against the dependency tree the sources file describes, which is the one from whenever it was last regenerated. CI runs the same script and opens a pull request when the two disagree, and the CI Flatpak job is what actually catches it.

### Things that cost an afternoon to rediscover

All of these were hit while getting the first build green, and all of them fail in ways that do not point at the cause:

- **`--config.electronDist` is what keeps the build offline, not the download cache.** Putting the Electron zip in `$XDG_CACHE_HOME/electron` at exactly the path electron-builder writes to is not enough: `@electron/get` re-fetches `SHASUMS256.txt` to validate it on every run, and that fetch is not cached. Pointed at a *directory* containing `electron-v<ver>-linux-x64.zip`, electron-builder extracts it in-process and never opens a socket.
- **A YAML folded scalar (`>-`) keeps the newline before a more-indented continuation line.** A `build-command` split across lines for readability becomes two commands. Keep each one on a single physical line.
- **The scalable SVG icon must not be installed.** `appstreamcli compose`, which flatpak-builder runs at the end of every build, cannot rasterise SVG inside `org.flatpak.Builder` and fails the whole build with `icon-file-read-error`. The PNG set is rendered from that SVG anyway.
- **`flatpak build-export` refuses icons larger than 512×512.** The 1024px PNG ships in the `.deb` and nowhere else.
- **Granting only `--socket=x11` does not fall back gracefully.** Electron 43 defaults its Ozone hint to `auto`, sees `WAYLAND_DISPLAY`, fails to find a Wayland socket, and *exits*. Both sockets are granted.

## Conventions

**Every constructed argv is a pure function with a test.** `buildPowerArgv`, `buildLaunchArgv`, `buildUrlRoute`, `buildOpenArgv`, `hostCommand`, `buildDesktopEntry`, `buildFlatpakUpdateArgv`, `buildFlatpakCommitArgv`. The reason is not purity for its own sake: these produce commands that suspend a machine, kill a process, write a file that runs at login, or replace the running application, and the test suite must be able to assert the exact string without ever executing it. When you add another one, follow the pattern.

**Anything crossing the IPC bridge is validated on the main side.** `isPowerAction`, `isLaunchRequest`, `isAccentId`, `isScaleId`, `sanitise()`. The channel is where the renderer stops being ours, and an unvalidated payload becomes a `TypeError` that crosses as a rejected promise — the one result shape the renderer does not model.

**Failures are surfaced, never swallowed.** There is no keyboard in front of this app. A control that silently does nothing is the only failure the user cannot diagnose, which is why `LaunchNotice` exists, why the power dialog shows polkit's refusal verbatim, and why the footer reports a blurred window rather than letting gamepad input die quietly.

**`console` goes to a file, so write for the person reading it a week later.** `src/main/log.ts` tees every `console.*` call — from both processes — into `logs/gfn-launcher.log`, which is the file the README asks people to attach to an issue. Two things follow. Log the *decision*, not just the outcome: "launching via web [mode=auto, client not installed]" answers a question, "launch failed" does not. And log sparingly on anything that repeats — the session watch fires a probe every one to ten seconds and only its four phase transitions are written down, because a file nobody can skim is a file nobody reads.

**Never log a value read out of NVIDIA's files.** `redactSecrets` runs over every line and takes out tokens, JWTs, emails and MAC addresses, but it is the second line of defence and not the first. `parseZoneAssignment` returns six declared fields, `streamLog.ts` logs offsets rather than chunks, and both of those rules still stand.

**A file the launcher owns is written through `writeFileAtomic`.** Sibling, `fsync`, `rename`. The launcher has a power menu, so a write interrupted by the machine going off is ordinary rather than hypothetical, and a truncated `settings.json` reads as no settings at all.

**Adding a `Settings` field means adding a branch to `sanitise()`** in `src/main/settings.ts`. It is an explicit allow-list: a field without a branch is dropped on every read *and* every write, which the user experiences as "my setting does not save".

**Adding a footer legend entry means adding a keyboard binding.** `ACTION_KEYS` is derived from `KEY_BINDINGS`, so an action with no key bound has its row dropped and the entry vanishes whenever no pad is connected.

## Tests

`npm test` runs 290-odd unit tests with vitest, no DOM environment and no Electron. Everything tested is a pure function, deliberately: parsers over third-party wire shapes (`parseZoneAssignment`, `parseVersion`, `mapApp`, `mapDetails`), the focus scorer (`scoreCandidate`), the QR path builder (`qrPath`), and the argv builders above.

Three suites carry a guarantee rather than just coverage:

- **`src/main/status/zone.test.ts`** asserts the exact key set returned by `parseZoneAssignment`. Its fixture contains a session blob, because the real `sharedstorage.json` holds a live bearer token, an `idToken` JWT with the user's email, and the machine's MAC address. That assertion is what stops a widened return type from carrying secrets into the renderer. Do not relax it.
- **`src/shared/donate.test.ts`** pins the protocol, the host and the hosted button id of `DONATION_URL`. It is the one string in the launcher that sends someone else's money somewhere, and it is encoded into a QR that nobody can proofread by eye.
- **`src/shared/games.test.ts`** pins `launchMode` defaulting to `native`. `auto` silently degrades to a browser window when a `flatpak` probe fails transiently, which is not what a user who installed the native client asked for.
- **`src/shared/update.test.ts`** pins the host and repository of the two release URLs, and **`release.test.ts`** pins that an asset digest must be 64 hex characters or be treated as absent. Between them they are what keeps "the launcher replaces its own binary" pointed at this project's releases and refuses to install anything it could not verify. `version.test.ts` sits beside them because the ordering rule that matters — a pre-release is *older* than the release it precedes — is the one a three-number compare gets wrong.

## What to check by hand

The suite cannot reach the parts that matter most. Before a release, on real hardware:

- A pad moves focus and the footer legend matches the pad in your hands (unplug it — the legend should switch to keycaps).
- A game actually launches, and launches a *second* time in the same session (the second one exercises the kill-and-respawn path, the stream log's rotation, and `disarmHandback` all at once — and specifically, the launcher must *not* pop up during the two-second kill settle).
- **Power → Back to desktop, then click the launcher in the taskbar: it comes back fullscreen.** That path never reaches the main process, so it is `holdFullscreen`'s `restore`/`show` listener doing it and nothing else — and it is per-compositor, which is why no test can stand in for this one. Then flick "Open fullscreen" off and on in Settings and watch the window follow immediately; with no keyboard in the room that row is the only way back to fullscreen.
- **An update notice, on the install form you are actually shipping — all the way through the restart.** The Flatpak path needs a remote to update from; installed from the `.flatpak` bundle by hand there is none, and the correct outcome is the notice saying so rather than claiming success. Check `flatpak info --show-commit io.github.robertotucci.GfnLauncher` moved. On the AppImage, watch the byte counter climb, then confirm the file at `$APPIMAGE` is the new size and still executable.

  Then let the countdown run out rather than pressing "Restart now", and watch the launcher come back **on the new version, fullscreen, with the pad working**. This is the check that cannot be automated and the one most worth doing: a Flatpak restarts by handing a shell to the host through the portal, and everything about that — whether the child survives our exit, whether the wait loop sees the instance leave `flatpak ps`, whether the new instance gets the single-instance lock — is a property of the machine rather than of the code. If it goes wrong the symptom is a television with no launcher on it, so also try it once with `--talk-name=org.freedesktop.Flatpak` revoked in Flatseal: the launcher must stay up and say why instead of closing itself.
- The launcher stays put when a game starts — never iconified — and comes back **fullscreen and focused, with the pad working**, within a few seconds of you quitting the game. Watch the client go with `watch -n1 flatpak ps --columns=application`. On **Wayland** this is the check that matters: everything a main process can do to raise a window there is a request the compositor may decline.
- Quitting the GeForce NOW client from its own UI, without ever streaming, still brings the launcher back — that is the half of the watch that does not depend on the client's log format.
- With `--filesystem=~/.var/app/com.nvidia.geforcenow` revoked in Flatseal: games still launch, one warning names the path and the errno, nothing closes the client for you, and quitting it by hand still restores the launcher.
- The screen stays on through a long browse with the pad, and goes off a few minutes after you stop. Both halves matter: the second is what stops the launcher from being a program that quietly disables your blanker.
- The Status screen names your datacenter.
- The autostart toggle writes an entry that survives a session restart — and after a full reboot the launcher comes up fullscreen **with focus**, answering the pad, with nothing clicked. `StartupNotify=true` in the entry is what buys that; its absence looks like nothing and feels like a dead launcher.
- Power actions work, and a refused one shows the refusal.
- A phone scans the code on the Support screen and lands on the right PayPal button. `zbarimg` on a screenshot proves the rendering; only a camera proves it is legible at three metres.
- **The log file exists at the path Settings prints, and reads as an account of the session you just had.** Launch a game, quit it, change a setting, and check that the file names all three. Then `grep -Ei 'bearer|eyJ|@|([0-9a-f]{2}:){5}' logs/gfn-launcher.log` — a hit that is not already `<redacted>`, `<email>` or `<mac>` is a bug in `redactSecrets`, and the file is the one the README tells people to paste into a public issue.

## Releasing

Versions are tags; CI does the rest.

```bash
npm version <patch|minor|major>   # writes package.json + package-lock, creates the tag
git push --follow-tags
```

See [RELEASING.md](./RELEASING.md) for the full procedure, including what to check by hand and what to regenerate after a dependency change.

## Licence

By contributing you agree that your contribution is licensed under the [GNU AGPL v3](./LICENSE), the same terms as the rest of the project.
