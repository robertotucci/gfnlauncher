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
flatpak run io.github.robertotucci.GfnLauncher
```

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

**Every constructed argv is a pure function with a test.** `buildPowerArgv`, `buildLaunchArgv`, `buildUrlRoute`, `buildOpenArgv`, `hostCommand`, `buildDesktopEntry`. The reason is not purity for its own sake: these produce commands that suspend a machine, kill a process, or write a file that runs at login, and the test suite must be able to assert the exact string without ever executing it. When you add another one, follow the pattern.

**Anything crossing the IPC bridge is validated on the main side.** `isPowerAction`, `isLaunchRequest`, `isAccentId`, `isScaleId`, `sanitise()`. The channel is where the renderer stops being ours, and an unvalidated payload becomes a `TypeError` that crosses as a rejected promise — the one result shape the renderer does not model.

**Failures are surfaced, never swallowed.** There is no keyboard in front of this app. A control that silently does nothing is the only failure the user cannot diagnose, which is why `LaunchNotice` exists, why the power dialog shows polkit's refusal verbatim, and why the footer reports a blurred window rather than letting gamepad input die quietly.

**Adding a `Settings` field means adding a branch to `sanitise()`** in `src/main/settings.ts`. It is an explicit allow-list: a field without a branch is dropped on every read *and* every write, which the user experiences as "my setting does not save".

**Adding a footer legend entry means adding a keyboard binding.** `ACTION_KEYS` is derived from `KEY_BINDINGS`, so an action with no key bound has its row dropped and the entry vanishes whenever no pad is connected.

## Tests

`npm test` runs 260-odd unit tests with vitest, no DOM environment and no Electron. Everything tested is a pure function, deliberately: parsers over third-party wire shapes (`parseZoneAssignment`, `parseVersion`, `mapApp`, `mapDetails`), the focus scorer (`scoreCandidate`), and the argv builders above.

Two suites carry a guarantee rather than just coverage:

- **`src/main/status/zone.test.ts`** asserts the exact key set returned by `parseZoneAssignment`. Its fixture contains a session blob, because the real `sharedstorage.json` holds a live bearer token, an `idToken` JWT with the user's email, and the machine's MAC address. That assertion is what stops a widened return type from carrying secrets into the renderer. Do not relax it.
- **`src/shared/games.test.ts`** pins `launchMode` defaulting to `native`. `auto` silently degrades to a browser window when a `flatpak` probe fails transiently, which is not what a user who installed the native client asked for.

## What to check by hand

The suite cannot reach the parts that matter most. Before a release, on real hardware:

- A pad moves focus and the footer legend matches the pad in your hands (unplug it — the legend should switch to keycaps).
- A game actually launches, and launches a *second* time in the same session (the second one exercises the kill-and-respawn path, which is the normal case and the one that used to fail silently).
- The Status screen names your datacenter.
- The autostart toggle writes an entry that survives a session restart.
- Power actions work, and a refused one shows the refusal.

## Releasing

Versions are tags; CI does the rest.

```bash
npm version <patch|minor|major>   # writes package.json + package-lock, creates the tag
git push --follow-tags
```

Update `CHANGELOG.md` before tagging — the release notes and the AppStream `<releases>` block are both generated from it.

## Licence

By contributing you agree that your contribution is licensed under the [GNU AGPL v3](./LICENSE), the same terms as the rest of the project.
