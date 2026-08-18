# Architecture

This document explains how GFN Launcher is put together and, more importantly, *why* — the constraints that produced each decision, so that changing one does not quietly break another.

For the reverse-engineered GeForce NOW client API this launcher speaks to, see [docs/gfn-api.md](./docs/gfn-api.md). For setting up a development environment, see [CONTRIBUTING.md](./CONTRIBUTING.md).

## The product, in one paragraph

A console-like launcher for NVIDIA GeForce NOW. It runs fullscreen on a TV, is driven entirely by gamepad, starts with the desktop session, and hands game launches to the already-installed native GFN client. The user is on a couch, three metres from the screen, with no keyboard or mouse. Linux only — GeForce NOW here is the `com.nvidia.geforcenow` Flatpak.

Almost every decision below follows from that one sentence.

## The three Electron contexts

Strictly separated. `src/shared/` is the only code all three import, so it must stay free of Node and DOM APIs — it has to compile into every bundle.

- **`src/main/`** — everything privileged: spawning the GFN Flatpak, autostart registration, catalog cache on disk, settings, and all calls to NVIDIA backends. The renderer never spawns a process, touches the filesystem, or holds a GFN token.
- **`src/preload/`** — one `contextBridge` object exposing `window.launcher`. Every method is an explicit passthrough; there is deliberately no generic `invoke(channel, …)` escape hatch, so the renderer can only reach the channels listed in `src/shared/ipc.ts`.
- **`src/renderer/src/`** — React UI only, reaching outward solely through the bridge.

`sandbox: true` is on, which means **the preload cannot be an ES module**. `electron.vite.config.ts` forces CommonJS output (`index.cjs`) for the preload build specifically; `package.json` is otherwise `"type": "module"`. Changing either side breaks startup.

## The host boundary

The launcher exists to control the machine it runs on: it starts and stops another Flatpak, reads that client's configuration off this disk, suspends the computer, and registers itself in the session's autostart. Packaged as a Flatpak itself, it is no longer the host, and none of those things work as written. `src/main/host.ts` is the one place that knows this.

`hostCommand(command, args)` returns its arguments untouched outside a sandbox and rewrites them as `flatpak-spawn --host -- <command> <args>` inside one. Four modules go through it — `gfn/flatpak.ts`, `gfn/launch.ts`, `power.ts` and `autostart.ts` — rather than each carrying its own branch, for the same reason `stepAside()` exists: two copies of a rule diverge and only one of them gets fixed. It is pure, and `host.test.ts` pins the unsandboxed form, so the AppImage and the `.deb` run the exact argv they ran before the module existed.

Three details are not what you would guess, and were checked against flatpak 1.18.1 rather than assumed:

- **The `--` separator is required and is consumed.** Without it `flatpak-spawn` reads the child's flags as its own, and every caller here passes flags, starting with `flatpak run --command=…`.
- **`flatpak-spawn --host` does not forward the sandbox's environment.** A host command inherits the host session's env, so setting `LC_ALL` on our own process reaches nothing. `hostCommand` turns an `env` option into explicit `--env=K=V` flags; `probeGfn` depends on this, since `parseVersion` reads a label out of `flatpak info`.

- **Unsandboxed, the opposite problem: our environment is Chromium's, and it is poison to the client.** Electron sets `EGL_PLATFORM=wayland` in `process.env` for its own GPU process. A child started from the main process inherits it, and `flatpak run com.nvidia.geforcenow` carries it into the GeForce NOW client's CEF, **which dies with SIGTRAP about three seconds in** — the window appears, shows in `flatpak ps`, and is gone by the fourth second. The same command with the same spawn options from a plain Node process runs indefinitely; bisecting the five variables Electron injects names this one and only this one. The symptom is the worst kind here: Play starts the client, the launcher steps aside, and the screen returns to the desktop with nothing anywhere saying why. It reaches the AppImage and the `.deb` — the Flatpak is spared only because `flatpak-spawn --host` does not forward our environment either.

  So every child this module starts gets `hostEnvironment()` instead of `process.env`: ours, minus `EGL_PLATFORM`, `GDK_BACKEND`, `FC_FONTATIONS`, `NO_AT_BRIDGE` and `CHROME_DESKTOP`. They are deleted rather than restored because there is nothing to restore them to — three of the five are already set before the first line of `index.ts` runs, so no snapshot taken from JavaScript can see what the session had, and unset means the child autodetects, which is what it would have done had the launcher not been a Chromium application.
- **Failures need four categories, not two.** `classifyHostFailure` separates `missing`, `failed`, `blocked` and `timeout`. `blocked` is a sandbox with the host permission revoked: collapsing it into `missing` renders as "GeForce NOW is not installed", which sends the user to reinstall a client that was there all along, so `GfnClientInfo.error` carries the reason to the Settings screen. `timeout` is the portal itself having stopped answering, which fails *every* call on this boundary identically and is therefore never about the command that happened to hit it.

  Every call here is bounded by `HOST_TIMEOUT_MS`, and that bound is not about latency. Two places turn an unanswered portal call into a stopped launcher rather than a slow one: `createWindow` awaits `getSettings()`, which reads the autostart entry through here, so a hung call means no window ever opens; and `handback`'s watch schedules its next probe from the *result* of the last one, so a hung probe ends the watch silently and the launcher never comes back after a game. `hostExecStreaming` — one caller, `flatpak update` — uses an *inactivity* timeout instead, for the reason `download.ts` does: any total figure generous enough for a slow line is far too long to notice a dead one.

  Telling them apart is fiddlier than it looks. Both arrive prefixed `Portal call failed:`, so that prefix discriminates nothing. Worse, the informative half of the "cannot start" case is generated by the portal **on the host, in the host session's language**, and arrives already translated — so matching "no such file or directory" works in English and nowhere else. The only stable things are a D-Bus error name (`org.freedesktop.DBus.Error.ServiceUnknown`) and the untranslated `Failed to start command:` prefix. Note in particular that "permission denied" is the *translated inner text for a host file that is not executable* — a `missing`, not a sandbox refusal. `host.test.ts` keeps the Italian fixture for exactly this reason.

`autostart.ts` is where the sandbox does the most damage quietly, because it writes a file, does not fail, and simply never starts anything. Three things vary with the install:

- **`XDG_CONFIG_HOME` is the wrong answer inside a Flatpak.** The runtime points it at `~/.var/app/<id>/config`, which nothing at login reads. The real `~/.config/autostart` is bind-mounted at its true path by `--filesystem=xdg-config/autostart:create`, so the literal path is the portable one and the environment variable is the trap. Outside a sandbox it still wins, because there it means what it says.
- **`Exec=` cannot be the running executable** in either packaged form — `/app/…` exists only inside the sandbox, and an AppImage's mount path is temporary. So it is `flatpak run <id>`, `$APPIMAGE`, or the exe path, in that order.
- **`Icon=` is a theme name, not a path**, and the name differs: the `.deb` installs `gfn-launcher`, a Flatpak installs under the app id.

`buildDesktopEntry` is pure so all three shapes are assertable without writing to anyone's home directory.

Two more things the sandbox needs, which are permissions rather than code: `--filesystem=~/.var/app/com.nvidia.geforcenow:ro` for the Status screen's read of `sharedstorage.json`, and read access to the Flatpak install roots for `appConfig.ts`. Both degrade rather than throw when denied.

A third, and the only one whose denial is undetectable: the three `--talk-name`s that let `displaySleep.ts` inhibit screen blanking. A `powerSaveBlocker` whose D-Bus call the sandbox refused still hands back a valid blocker id and still reports `isStarted()`, so there is nothing to classify and nothing to surface — the symptom is the screen blanking, which is also the symptom of not having asked. Chromium picks the interface the session offers, hence three names rather than one.

## Input and focus

Two systems that are easy to conflate. They are separate.

### `src/renderer/src/gamepad/` — hardware into intents

One `requestAnimationFrame` loop for the whole app, in `GamepadProvider`, fanning out to subscribers held in a ref so delivering an intent never re-renders the provider. Per-component polling would each run its own repeat clock and the UI would accelerate unpredictably. Buttons edge-trigger once per press; directions hold-to-repeat. `intents.ts` holds the button map, deadzone, repeat timings and the keyboard mirror.

The button map:

| Button | Action |
| --- | --- |
| A | Details — opens the panel, from a tile or a search result |
| B | Back |
| X | Search |
| Y | Settings |
| ☰ Menu/Start (index 9) | Play |
| LB / RB | Step through the set in front of you — genres on the grid, screenshots in the viewer |

The keyboard mirror of ☰ is **F1, not a letter**, and LB/RB are `[` and `]`. The search overlay types letters, and by the same rule that keeps `Backspace` off "back", a key cannot mean both.

**The action is called `start`, not `details`.** Button 9 has no meaning of its own — it plays on the grid and closes on the details panel — so it is named after the physical button. Naming it for one of its two jobs is how you end up with a `case 'details'` branch that launches a game.

A opening the panel means the handoff costs two presses, both on A: `openDetails` lands the cursor on **Play**, so A-A is the whole journey. ☰ keeps the one-press launch for someone who already knows what they want. Handing a game to GFN is still what the launcher is *for* — it just is not what a bare A does.

**A button can mean different things on different layers, and the legend says so.** Inside the details panel A is Play, Set launch store, or View depending on which element holds focus, and X — inert there, since there is nothing to search — becomes "mark owned". So the `detailsGame` branch of the legend in `App.tsx` reads `focusedId`, not just state. A footer that says "Play" while A sets a store is worse than no footer.

**The footer legend names actions, not buttons.** A `LegendEntry` carries `{ action, label }`; `glyphFor` in `src/renderer/src/components/glyphs.tsx` resolves the glyph from `useGamepad().scheme`, so the same row reads `A` / `✕` / `ENTER`. The scheme is last-touched-wins — a bound keypress switches it to `keyboard`, any pad input switches it back, and no pad connected forces `keyboard`, because the legend is the only manual the user gets and it has to describe the thing in their hands. `scheme.ts` reads the family off the Chromium pad id (Sony's vendor `054c`, else the product name; Xbox is the fallback, since the standard layout is named after it). Keyboard labels come from `ACTION_KEYS`, derived from `KEY_BINDINGS` rather than written out again — an action with no key bound has its row dropped, so a new legend entry needs a keyboard binding or it vanishes when the pad does.

Glyphs come from Lucide where the button really is a shape (PlayStation's `X` / `Circle` / `Square` / `Triangle`, and `Menu` for ☰ on both pads) and stay as text where it is a character (Xbox's A/B/X/Y, `LB`/`RB`, keycaps). They were Unicode literals once; a face font with no `△` in it turns the footer into tofu, and the launcher has to render correctly offline on whatever it shipped with.

### `src/renderer/src/focus/SpatialFocus.tsx` — where focus goes

A tile grid needs geometry, not DOM order: pressing down has to land in the same column, which document order cannot express. `scoreCandidate` (pure, unit-tested) rejects candidates that are not in the direction of travel, then ranks the rest by distance plus an orthogonal-drift penalty.

**A candidate that overlaps the cursor on the cross axis outranks every candidate that does not**, and the drift penalty only orders the peers within each group. The penalty alone is a weight, so anything far enough to the side can be bought back by being close — which on the Settings screen was not a near miss but the wrong answer: the first row sits at y 240–325, the nav rail's Status button at y 324–415 beside it, and the next settings row 278 px below, so Down on the first setting scored Status at 171 against 278 and left the panel for something level with it. Anything in front wins; distance decides between peers. Off-axis targets stay *reachable* — the cost is a large constant, not a filter — because at the top of a list there is nothing above but the rail and Up has to get there. `primary` is floored at zero for the same reason: `EPSILON` lets a candidate qualify from slightly behind the cursor's trailing edge, and a negative distance would otherwise be a reward for it.

Consequences worth knowing before changing UI code:

- Register interactive elements with `useFocusable(id, { scope, onConfirm })`. An element that is not registered is unreachable — there is no pointer fallback.
- `scope` isolates a layer. The search overlay uses `SEARCH_SCOPE` and the details panel `DETAILS_SCOPE`; navigation only ever considers the active scope. Ids are global across scopes, so they are namespaced (`tile:`, `result:`, `detail:`).
- **A closed layer hands focus back explicitly.** `setActiveScope(ROOT_SCOPE)` alone re-runs `focusFirst`, which lands on the nav rail rather than the tile the user came from; `closeDetails` in `App.tsx` restores the remembered id instead. The screenshot viewer (`SHOTS_SCOPE`, z-40) does the same one layer up, back to the exact thumbnail, `closePower` returns to `nav:power`, and `closeSearch` returns to the tile the overlay was opened from — but only when that tile is still in `visibleGames`, since search covers the whole catalog while the grid behind it may be a genre or the library, and `focus()` on an unmounted id parks it as pending and gags recovery until the next scope change.
- **Focus is virtual.** `SpatialFocus` tracks a `focusedId` in React state and **never calls `element.focus()`**, so `:focus-visible` never matches and shadcn's `focus-visible:` variants are inert. Every focusable paints `focus-ring` off the `focused` boolean instead.
- **The "land in the content" effect keys on the reason, not the data.** `visibleGames` changes identity whenever a genre is picked or a title is marked owned, and watching the list would yank the cursor out of an open panel. It compares a `view/genre` string against a ref, skips while any overlay is up, and — the subtle part — records the landing *only once it has a target*, because the grid is empty on first paint and marking it done there strands focus on the nav rail.
- Overlays are conditionally mounted, so an exit animation needs the layer kept alive while it plays — hence the `closing` flag and the `EXIT_MS` timeout in `App.tsx`.
- A second *focus model* must not nest inside a focusable, and neither must a second **element**. Virtual focus makes an inert Radix control harmless to the cursor, and that was taken as licence to render a real shadcn `<Switch>` inside `SettingsScreen`'s toggle rows — but a Radix `Switch` is a `<button>`, `Row` is a `<button>`, and interactive content nested in a button is invalid HTML. React says so out loud, and since `log.ts` tees the renderer's console into the file the README asks people to attach, the cost was the launcher filling its own capped log with two errors and a twenty-line component stack per visit to the screen. The indicator is spans now, with the same geometry and tokens. The rule: inert is about *behaviour*, and the DOM has its own opinion about nesting.
- Focus decides whether input is acted on at all, and the launcher — not Chromium — is what decides that. See below.

### Who is allowed to drive the launcher

**The Gamepad API is documented as reporting only to a focused window, and on Linux it does not.** Chromium stops sampling pads when the *page* stops being visible; a fullscreen window that another fullscreen window happens to be covering is still visible. So the launcher, which deliberately does not step aside when a game starts, sat behind the stream receiving live pad data and acting on all of it: the cursor walked the grid, actions fired, and since ☰ is Play a pause menu could reach `gfn:launch`, whose first act is to kill the client that is streaming. That invariant was asserted as prose in about ten places in this repository and enforced in none of them.

`shouldAcceptInput` in `src/shared/input.ts` is the enforcement, and it is three lines rather than one because gating on focus alone is the trap:

| focused | minimised | handedOff | input |
| --- | --- | --- | --- |
| yes | — | — | accepted |
| no | yes | — | ignored — Back to desktop, `gfn:open` |
| no | no | yes | **ignored — the bug** |
| no | no | no | accepted — the compositor declined focus |

**The last row is why main is involved at all.** On Wayland a raise is a request the compositor may refuse — `restoreLauncher` logs `focused=false` after its own `focus()` call, and an autostart entry predating `StartupNotify=true` comes up unfocused at every login. A focus-only gate would turn each of those into a launcher sitting alone on the screen answering nothing, which is worse than the bug and, with no keyboard in the room, unrecoverable. So being unfocused is only disqualifying when *somebody else demonstrably has the screen*, and only main can know that: from inside the window, "GeForce NOW is streaming on top of me" and "a notification took the focus for a second" are the same event.

`src/main/screen.ts` owns that fact and pushes it over `app:screen`, one of four main → renderer channels — the others being `update:progress`, and `gfn:client` and `status:zone` from [the client watch](#following-the-client-while-it-changes). What they have in common is the test a fifth would have to pass: the renderer cannot ask, because it has no way of knowing there is anything to ask about. `handedOff` is set for the whole of a launch (from before `killGfn` runs, so the kill settle is covered), for `gfn:open`, for the web-stream window, and for the sign-in window — the last of these being where the user is typing a password while the grid is driven blind behind it. It is released by `armHandback`'s `onEnded`, which fires however the session watch ends and not only when the client goes away.

**Everything here fails open.** The renderer starts from `SCREEN_OURS`, a push that never arrives costs correctness rather than control, and a focused window is accepted unconditionally so no latch can gag a launcher somebody is looking at. A stray press behind another window is a bug; a pad that has gone dead on a television is the end of the product.

**The other half of the fix is the boundary, and it is in `stepPad`.** Suppressing input is not enough on its own: the button that quit the game is still down when the launcher comes back, and a naive edge detector reads that as a fresh press. `src/renderer/src/gamepad/pad.ts` is a pure reducer over one frame — the same bargain `stepHandback` makes, and the only way any of this is testable in a suite with no DOM — and the first frame after a suspension is *adopted* rather than compared. A direction held across the boundary carries `repeatAt: null`, so it never starts repeating either; recentring the stick clears it. `MAX_FRAME_GAP_MS` applies the same adoption after any stall longer than 250 ms, because `requestAnimationFrame` can be throttled for a blurred window and an edge measured against a reading from an unknown time ago is not an edge — that is the half of the fix that does not depend on the focus signal arriving at all.

Both sides log their transitions, and the pair is the diagnostic: main writes `Launcher gained/lost focus`, the renderer writes `Pad input suspended/resumed` with a count of the frames on which the pad reported something while it was suspended. A large count is Chromium feeding a blurred window, which is the fault this exists for; a zero across a session somebody knows they mashed the pad through means something else changed.

## Where shadcn/ui fits

shadcn is the UI framework, not just the theme layer: stock `neutral` dark tokens, `cn`, cva, the registry workflow, and the registry's own components — `Button`, `Badge`, `Card`, `Separator`, `Switch`, `Dialog`, `Skeleton`. Add more with `npx shadcn@latest add <component>`; `components.json` already points at `new-york` / `neutral` / `lucide`, and generated files land in `src/renderer/src/components/ui/` (excluded from lint).

Two adaptations the focus model forces, and only two:

- **Focus rings come from the `focused` boolean**, not from `focus-visible:`. Strip the `focus-visible:` classes off a generated component if you rely on them; keep them otherwise, they are harmless.
- **`<html class="dark">`** in `index.html`, with `@custom-variant dark (&:is(.dark *))` in `globals.css`. The launcher has no light theme, but every registry component ships `dark:` variants, and without the class those resolve against the desktop's colour-scheme preference instead of against us.

Overlays (search, details, screenshots) are hand-rolled `fixed` layers rather than Radix `Dialog`s. Their open/close choreography — `closing` flag, `EXIT_MS`, explicit focus restore — is the most carefully tuned code in the renderer, and Radix would want to own the focus trap, the Escape key and the restore target. The Power and Update dialogs **are** real `Dialog`s, because both were new and had nothing to break; each neutralises `onOpenAutoFocus`, `onCloseAutoFocus`, `onEscapeKeyDown` and `onPointerDownOutside` so B and Escape close them through one path. A third modal should copy that arrangement rather than invent a second one.

The only other UI dependency is `qrcode-generator` — zero transitive deps, ships its own types — behind `qrPath` in `src/renderer/src/lib/qr.ts`. `variants.storeUrl` is useless on a TV with no browser and no pointer, and a code the user photographs moves the link to the one device in the room that can follow it. The matrix is rendered as inline SVG rects rather than a canvas, so the dark modules take `currentColor` and stay on the palette. (`qrcode` was rejected: it pulls in `yargs` and `pngjs`.)

`qrPath` is a pure function rather than a hook body because two components draw the same matrix at different sizes — `StoreQr.tsx` in the details panel and `DonateScreen.tsx` — and because the one property nobody can check by eye is that every module lands inside the grid the `-2 -2 count+4` quiet-zone viewBox is built from. `qr.test.ts` checks it.

## GeForce NOW integration

### Launching a game

The CEF binary accepts a deep link in this exact shape:

```
--url-route="#?cmsId=<ID>&launchSource=<SRC>&shortName=<NAME>&parentGameId=<PID>"
```

**The Flatpak wrapper discards argv.** `/app/bin/GeForceNOW` reads `$1` only as a relaunch sentinel and then invokes `./GeForceNOW` with no arguments, so `flatpak run com.nvidia.geforcenow --url-route=…` silently drops the deep link and opens the home screen. `src/main/gfn/launch.ts` therefore targets the CEF binary directly and reproduces the wrapper's working directory:

```bash
flatpak run --command=/app/cef/GeForceNOW --cwd=/app/cef com.nvidia.geforcenow \
  --url-route="#?cmsId=<ID>&launchSource=External"
```

`launchSource=External` is a literal lifted from the shipped bundle — one of four values in an enum the bundle maps straight onto a telemetry dimension, so it tags provenance and selects no behaviour. Bypassing the wrapper also skips `GeForceNOW_Downloader` and the self-update check, so the launcher should not become the user's only way to start GFN.

**Which is why `gfn:open` exists and goes the other way.** `buildOpenArgv()` is a plain `flatpak run com.nvidia.geforcenow` — through the wrapper, precisely so the downloader and the self-update check *do* run. It is the Settings row that hands the screen to the real client for the things the launcher does not mirror (stream quality, account linking, controller mapping), and it is the one path that still `stepAside`s: a fullscreen launcher sitting on top of the window it just opened is a button that looks broken. **Launching a game does not**, and that is the subject of "Getting the screen back" below.

**Confirmed against client v2.0.87.130**: a cold start receives the route verbatim (`urlRoute value is: #?cmsId=…&launchSource=External&shortName=…`) and the app builds a streamer config from it. The parameter order in `buildUrlRoute` is not a guess either — the binary's own string table holds that template contiguously, because it is how the client relaunches itself. To watch a link arrive, grep `~/.var/app/com.nvidia.geforcenow/.local/state/NVIDIA/GeForceNOW/debug.log`; note the `.var` path, since the host-side `~/.local/state/NVIDIA/GeForceNOW/` holds only the *wrapper's* log and window geometry, and note that `console.log` beside it **contains tokens** — grep it, never paste it.

**A running client swallows the deep link, and that is why `launchGame` kills it first.** A second `flatpak run` carrying a route reaches the *new* process, which logs `Launched with URL route!` and then exits 0 within a millisecond without forwarding anything. The running client never learns the id. This is not an edge case — the client sits on the mall after a game exits, so it was the normal state from the second launch of a session onwards. "Getting the screen back" below now closes the client at that point, which makes it *rarer* and not gone: `gfn:open` starts a client nothing closes, and the auto-close is a convenience that is allowed to fail. The probe stays load-bearing. The old code handled it in the worst possible way: `spawnFlatpak` resolved `ok: true` because *flatpak* had started, so the launcher wrote play history for a game that never ran and minimised itself behind a client showing something else. So `launchGame` probes `flatpak ps`, calls `flatpak kill`, waits out `KILL_SETTLE_MS`, and only then spawns — a fresh instance racing the dying one is refused by the same lock that made the kill necessary. The probe is load-bearing, not defensive. It is also why `disarmHandback()` runs *before* `launchGame` and not after — see below.

**The web player is the fallback, not a peer, and it never happens by itself.** `src/main/gfn/webStream.ts` opens `play.geforcenow.com/mall/#/streamer?…` in a `BrowserWindow` on the `persist:gfn-session` partition, so a login captured by `webAuth` carries straight into it. `Settings.launchMode` chooses and `resolveLaunchPath` in `src/shared/games.ts` is the decision, but **the default is `native`, not `auto`** — deliberately. `auto` decides from `detectGfn()`, so a probe that fails transiently (`flatpak` not yet on `PATH` when the launcher autostarts with the session) reads as "no client" and quietly streams in a browser window instead of handing the game to the installed client. It would work, and it would not be what was asked for. `native` fails loudly instead, and `LaunchNotice` names the fix. `auto` stays available for anyone who wants it knowing the cost; `games.test.ts` pins the default so a refactor cannot flip it back.

Three more things about the web path:

- **The two clients ship different route tables**, so the two URL forms are not interchangeable. The Flatpak's bundle has a `deeplink` route and no `streamer`; the web build is the other way round.
- **The web route takes only a `cmsId`** — no `shortName`, no way to pin a store — so a multi-store title asks the user which one, where the native deep link resolves it for them.
- **It must not call `stepAside`.** That stream is our own window; a minimised launcher behind it could not be raised again once it closed, since there is nothing a pad can do to un-iconify a window. `restoreLauncher` in `main/window.ts` is the way back, and it re-applies fullscreen for the same reason `second-instance` does. It does still set `handedOff`, though: the stream window is fullscreen and takes the focus, so the launcher behind it is in exactly the position it is in behind the native client.

### Getting the screen back

**The client does not exit when a stream ends.** It returns to its own mall, fullscreen, holding the focus — and on a machine with no mouse that holds the launcher hostage, because there is nothing a pad can do to raise a window the compositor is not showing. Two changes follow, and they are a pair:

**Launching a game no longer minimises the launcher.** It used to, behind a `hideOnLaunch` setting that defaulted on, and the reasoning was sound in isolation: GFN takes the screen, so do not fight it for focus. What it produced was a dead end. GFN raises itself on its own — it is a new fullscreen window — so the minimise bought nothing, and an iconified launcher on Wayland is one the pad cannot raise. The setting is gone rather than defaulted off: two behaviours here is two things to test and one of them is broken.

**`src/main/gfn/handback.ts` closes the client and takes the screen back**, and it is deliberately *two* jobs with two signals, because they fail differently:

| | A — "the game ended" | B — "the client is gone" |
| --- | --- | --- |
| Signal | a marker in the client's stream log | `isGfnRunning()`, hinted by the child `exit` |
| Action | `killGfn()` | `restoreLauncher()` |
| If it breaks | no auto-close; the user quits GFN by hand | the launcher sits behind a dead client |

B does not depend on A. Rename a log line in the next client and A quietly stops being useful while B still brings the launcher back. That is the failure policy, and it comes from the decomposition rather than from error handling threaded through one function.

**A reads `logs/gameStreamClientAgent.log` in the client's state directory** — same tree, same `--filesystem=…:ro` grant, as the `sharedstorage.json` the Status screen reads. Four things about it were established from real runs rather than guessed, and `src/main/gfn/streamLog.ts` records the evidence:

- **The trigger is `IPC_STREAMING_MODE_EXIT_EVENT`, not `IPC_STREAMING_TERMINATED_EVENT`.** Terminated is the *stream* stopping and its payload carries `isResumable`: a network blip terminates a stream and the client reconnects on its own. Acting on it kills a game the user had not finished. Mode-exit fires a second later and means "went back to the mall".
- **`Creating StreamingMonitor` is not a stream marker.** It is line 1 of every run — the agent booting. `streaming started` is the per-stream one, and the parser gates on it so that a stale end-marker in a not-yet-rotated file cannot fire.
- **The end marker is emitted more than once**, so the fold latches rather than counts.
- **It may never be emitted at all** — a run that ends with the client being killed simply stops mid-file. B is what covers that.

**`fs.watchFile`, not `fs.watch`, and rotation decides it.** The client renames the log to `.bak` at start, and `launchGame` restarts the client on every launch, so rotation is the normal case. inotify watches the *inode*: after the rename the watch is attached to `.bak` and never sees another byte. Stat-polling watches the *path*, so the new inode arrives on its own and rotation is a comparison of `curr.ino`. Two smaller reasons point the same way — `stat(2)` behaves identically across the Flatpak bind mount where inotify is the one thing that could differ between packaged and `npm run dev`, and Node calls a `watchFile` listener with zeroed stats when the path does not exist, which makes "the client has not written anything yet" free rather than a retry loop.

**B's child `exit` is a hint and `isGfnRunning()` is the decision**, which is the inverse of the obvious assignment and the part most likely to be "simplified" back into a bug. Three things make the handle untrustworthy on its own: sandboxed, `flatpak-spawn` is waiting on a D-Bus signal and a dropped connection makes it exit while the client lives; the client can re-exec itself under the same app id; and a `flatpak run` carrying a deep link into an app that already holds the lock exits 0 within a millisecond, so if `KILL_SETTLE_MS` were ever short the exit would arrive two seconds after the spawn. Hence the asymmetry in the reducer: `streamEnded` kills, `childExited` only probes — killing on a re-exec would end an instance the client had just started for itself. And hence `GONE_CONFIRMATIONS`, because `isGfnRunning()` swallows every failure and answers `false`, which is right for the launch path and would otherwise pop the launcher over a live game on one bad `flatpak ps`.

**Two readings are not enough when the disappearance was only inferred.** `streamEnded` is followed by `killGfn()`, so a client that then vanishes is doing what it was told and two probes a second apart settle it. A bare `childExited` claims much less, and a re-exec is measured back in `flatpak ps` inside a second or two — which makes two eager probes exactly the wrong number, enough to miss the client and enough to conclude from missing it. So `state.closing` records which of the two nominated, and an inferred disappearance has to clear `UNSEEN_GONE_CONFIRMATIONS` instead. The extra seconds cost nothing where they are spent: on the launch path the launcher was never minimised, so they delay a raise rather than extend a black screen.

The handle also has to be *held*: `spawnFlatpak` drops every reference once its promise resolves, and an unref'd `ChildProcess` nobody references is collectable — a collected handle delivers no `exit`. That is what `LaunchHooks.onSpawned` is for, and why the handle travels by callback rather than on `LaunchResult`, which is structured-cloned across the bridge.

**`disarmHandback()` runs at the top of the `gfn:launch` handler, before `launchGame`.** Its first act is `killGfn()`, and a watch left armed by the previous launch would read that kill as "the session ended", find the client gone during `KILL_SETTLE_MS`, and raise the launcher on top of a launch two seconds from spawning.

Everything interesting is pure: `readStreamPhase` folds appended text, `stepHandback` is a total reducer over `{streamEnded, childExited, clientProbe}` returning named effects the shell performs. Neither needs a filesystem, a child process or an Electron window to test, which is the same bargain `buildPowerArgv` makes.

**The log is credential-free and not anonymous.** No bearer token — which is the only reason it is usable at all, unlike `console.log` beside it — but it carries the machine's LAN IP, session ids and the account's opaque user id. `readStreamPhase` returns two booleans and a bounded fragment; every diagnostic names the path and the errno and quotes no content. `streamLog.test.ts` asserts the returned key set, in the same spirit as `zone.test.ts`.

### Following the client while it changes

The launcher reads four things out of somebody else's application: the client's version and where it is installed (`gfn/flatpak.ts`), the service hostnames inside that install (`gfn/appConfig.ts`), and the routing configuration in its state directory (`status/zone.ts`). All four were read once and remembered, on the assumption that a client does not change mid-session. That assumption is false, and each way it fails is silent — which is why `src/main/clientWatch.ts` exists, armed once from `app.whenReady()` and disarmed on `will-quit`.

**An install path does not go stale, it goes away.** `flatpak info --show-location` answers with a *commit directory*, and an update deploys a new one and prunes the old. A remembered path is then an ENOENT rather than an older answer, and `readAlsServerUrl()` used to reply to that by memoising the default host — silently losing a proxy-overridden ALS server for the rest of the run, so every library sync afterwards talked to the wrong service. It now caches only a successful read. The other three failures are the visible ones: a footer naming the previous version, a Status screen naming the datacenter the user just left, and a client installed *after* the launcher started staying `installed: false` for ever, which sends `launchMode: auto` to a browser.

**The deploy pointer is the signal, not `flatpak info` on a timer.** An update repoints `~/.local/share/flatpak/app/com.nvidia.geforcenow/current/active`, and `stat` follows symlinks, so the deployed commit's inode arrives as an ordinary change; `current` keeps the path free of the architecture and the branch. Both installation roots are watched, per-user and system-wide, because the client may be installed either way — the two grants are already in the manifest. `~/.local/share/flatpak/.changed` would be one target instead of two and is deliberately unused: the grant is the *app subdirectory*, so that file is not visible from inside our own sandbox.

**`watchFile`, not `watch`**, for the three reasons already written out for the stream log above. Two intervals rather than one compromise: two seconds for `sharedstorage.json`, because somebody who has just re-pinned a region is walking back to the launcher, and ten for the deploy pointers in the spirit of `PROBE_LAZY_MS`, because nobody watches an update land.

**A probe that says the client is gone while its deploy pointer is still there is a failed probe, not an uninstall.** This is the rule most likely to be deleted as redundant, and it is the one thing standing between an ordinary `flatpak update` and a launcher announcing that GeForce NOW has vanished. The watcher re-probes precisely when the flatpak installation is busiest — the pointer moved *because* a transaction is running — and `probeGfn` cannot tell "not installed" from "the portal did not answer in time", since both arrive as a non-zero exit. So the pointer nominates, the probe describes, and only the pointer may authorise "absent". Same decomposition as the two signals in the section above, inverted.

**Only changes cross, and the comparison is the work.** `sameZone` compares the *resolved* zone rather than the file's mtime, because the client rewrites `sharedstorage.json` to rotate a token or bump a telemetry counter several times an hour and none of that is a routing change. `sameClient` treats a moved `installPath` as a change even when the version has not moved, since a re-deploy of the same version still relocates the file `appConfig.ts` reads. Both are pure and tested.

**`markMoved` is the third, and it is the one that is easy to get backwards.** `watchFile` does **not** call the listener when it arms against a path that exists — it takes that stat as its own baseline and stays silent, and the first call comes only when something changes. So a listener running with nothing recorded yet means one of two opposite things, and only `present` separates them: a *missing* path reports Node's documented single zeroed call, which is "GeForce NOW is not installed" and not an event; an *existing* path reporting for the first time has, by definition, just changed. Reading both as a baseline swallows exactly one change per path per run — and since a launcher is started once and a datacenter is changed once, that is *the* change, every time. It read that way for a day and the symptom was a Status screen that only caught up on the second change. The present→absent case is the other half: it is the client being uninstalled, and the stream log's `mtimeMs === 0` guard would swallow that too.

**There is no `did-finish-load` replay, unlike `screen.ts`.** Both pushed facts already have a pull the renderer performs at the right moment — `gfn.info()` at mount, `status.get()` on *every* entry to the Status view — and both read main's caches, which this module keeps current. `handedOff` has no such pull, which is why that one replays and this one does not.

### Backends

[docs/gfn-api.md](./docs/gfn-api.md) is the reference — endpoints, every GraphQL document, the filter shapes, and how each fact was derived. Read it before touching `src/main/gfn/`. What follows is only what shapes the code's structure.

Three distinct services, not to be conflated.

**The public game list — the whole catalog, no account.** `POST https://api-prod.nvidia.com/services/gfngames/v1/gameList`, a bare GraphQL document sent as `application/json`, and **a `User-Agent` is mandatory** or the connection is dropped with no status at all. ~5.9k titles in 8 pages of 750, about twelve seconds. It has no `searchQuery`, `orderBy` or `filters`, so `src/main/gfn/publicCatalog.ts` pages the lot and `fetchPublicCatalogGames` sorts it here. It knows nothing user-relative: everything comes back unowned, and `playabilityState` is deliberately not requested because signed out it reads `UNPLAYABLE_DUE_TO_UPGRADE` for every title. There is no per-app query and no language data.

This feed is also the only place the launcher reads **ray tracing** from: `variants { gfn { features { ... on GfnSubscriptionFeatureValue { key value } } } }`, whose entries read `{ key: "RTX_ENABLED", value: "true" }` — 171 titles, and 0.58 MB across the whole walk. The flag is **per variant** and 17 titles disagree across their stores, so `variantRtx` in `wire.ts` follows the GFN client and treats any ray-traced edition as enough for one badge.

Signed in, the flag is merged in from the public walk `refreshCatalog` already makes for the details panel. **Match on the variant id *and* on `sortName`** — the two feeds hand out different ids for the same Battle.net edition, and an id-only merge silently dropped the four World of Warcraft titles. `cmsId` is not a stable cross-feed key; the details index only gets away with it because it is built and read from the same walk.

**When probing this API, try `X { __typename }` before concluding `X` does not exist.** A bare object-typed field is an invalid document, and the gateway answers that with the same opaque 500 it gives an unknown field — which is how `features` ended up on the rejected list in `docs/gfn-api.md` for two sweeps. `keywords` looks like the RTX source and is not: its `rtx` marker misses Fortnite, Pragmata and Indiana Jones, and it costs 29 MB.

**GraphQL — catalog, library, ownership.** `https://apps.gxn.nvidia.com/graphql?requestType=<type>`, `Content-Type: application/json`, the partition's cookies, and `NV-Client-ID` / `NV-Client-Version` when the capture yielded them. `application/graphql` is what the bundle uses and what the gateway answers `400 transport not supported` to from here; the authentication is by **cookie**, not by bearer. `requestType` is a cache-partitioning hint, not a selector — the operation travels in the body.

**ALS (Account Linking Service) — store links and library sync.** REST at `{accountLinkingServerUrl}/v1/`; `POST /v1/sync/{providerId}` returns **202 Accepted** and completes asynchronously. Its base URL is *not* a constant: it comes from the client's runtime `appConfig` and a proxy override can replace it. It is never hardcoded — but it does not have to be intercepted either. **The `appConfig` is a plain JSON file inside the installed Flatpak**, at `<installPath>/files/mall/shared/assets/config/config.json`, and `src/main/gfn/appConfig.ts` reads `accountLinking.server` (`https://als.geforcenow.com`) straight out of it. That file is also where `lcars.serverUrl`, `starfleet.url` and `cms.server` live: look there before guessing at any GFN host. Note the path is `/v1/`; the `/v2/` this document carried for two sweeps was never observed.

**ALS does not take the cookies, and that cost a release.** GraphQL authenticates off the partition's cookie jar, so the first version of `als.ts` assumed a sibling service on the same registrable domain would too, and sent no `Authorization` at all. Every sync came back 401. The shipped client sends `Bearer <Starfleet id token>` — `AlsService.providerSync` → `createHeader` → `IdmService.getAuthToken` → `StarfleetService.getAuthToken` → `session.data.idToken` — while LCARS, the Starfleet KV store and GXT use `GFNJWT <token>`, which is the credential a capture actually sees. Three services, three schemes; the launcher had the wrong one for two of them and no one for the third. That id token is on no request the launcher can intercept (the web app calls ALS only on link, unlink and sync), so `webAuth.ts` reads it from the hosted page's own IndexedDB — `db "starfleet"`, key `starfleetSession`, value `{authProvider, data}` with `data` a base64 of a percent-encoded JSON session — and keeps `idToken` and nothing else. `getAlsToken` in `session.ts` withholds it past its `exp`; a 401 in spite of that buys one silent re-capture and one retry, never a loop.

Three things about the GraphQL API drive the design:

- **Search and filtering are server-side**, with cursor pagination (`first` / `after`). The catalog runs to thousands of titles — never fetch it all and filter in the renderer. `paginate()` in `graphql.ts` caps at 10 000 (the catalog measured 5 890 in August 2026, so the previous 5 000 was silently dropping titles) and reports truncation rather than looping forever against an API we do not control. The public feed above is the exception, and only because it offers no server-side filtering at all.
- **"My library" is a filter, not an endpoint**: `{variants:{gfn:{library:{status:{notEquals:"NOT_OWNED"}}}}}` on the same `apps` query.
- **An app has one variant per store.** The launchable id is a *variant* id, so `mapApp` picks the variant GFN marked `selected`, then any owned one, then the first — mirroring what the client does on play. An app with no variant id is dropped: its tile would render but never launch.
- **`sortString: 'ALPHABETICAL'` is sent and not honoured.** A signed-in walk of the full catalog comes back in whatever order NVIDIA's panels are assembled in — verified against a real cache, which began "Wolcen: Lords of Mayhem, Half-Life 2, Rage, Tomb Raider: Anniversary". The public feed has no `orderBy` at all and never claimed to. So neither source can be trusted for order, and `sortByName` runs on the way out of *both*: without it the Catalog grid was alphabetical signed out and arbitrary signed in, which is the same screen behaving differently for reasons the user cannot see.

`GfnGame.cmsId` is that picked variant, and it is also the game's **identity** — focus ids (`tile:`, `result:`), the details index key, the cache key. So when the user picks a different store it is *not* rewritten; `selectedVariantId` records the choice and `resolveLaunchTarget` in `src/shared/games.ts` resolves it at launch. Each `GameStoreOwnership` therefore carries its own `variantId`, `shortName` and `storeUrl`. Resolve the id and the slug **together**: pairing a chosen edition's id with another store's slug still produces a valid deep link, pointing at the wrong thing, and nothing reports an error.

`LaunchRequest` therefore carries **both** ids: `cmsId` is the variant the deep link gets, `gameId` is the `GfnGame.cmsId` it came from. Anything on our side of the bridge that has to match a tile — play history, today; anything keyed on identity, tomorrow — reads `gameId`. Keying it on the launched variant instead would silently fail to match on exactly the ~850 multi-store titles, and only for users who had picked a store.

`mapApp` isolates the wire schema from `GfnGame`, the launcher's own model — a GFN schema change should stop at that function. The wire types and the two decisions both mappers must agree on (`pickLaunchVariant`, `imageUrl`) live in `src/main/gfn/wire.ts`.

### Two models, two caches

`mapDetails` in `src/main/gfn/details.ts` is the second mapper, producing `GameDetails` — description, screenshots, controls, subscriptions, release date. It exists because there is **no per-app query**: everything the details panel shows must be harvested during the same walk or not at all.

The result is deliberately *not* folded into `GfnGame`. `catalog.json` (~5 MB) is what `catalog:get` clones to the renderer on every start; `details.json` (~9 MB) stays in main and is read one title at a time through `catalog:details`, lazily parsed on the first request of a cold start. Both are memoised in their module (`patchGame` would otherwise re-read five megabytes to change one field).

Two things keep the panel from silently coming up empty — the failure mode here, since a missing key throws nothing:

- **Details are indexed per variant, not per app.** Signed in, a tile's id is the edition the user owns; the details index is built from the public feed, which knows no ownership and settles on Steam. Keying only the launch variant would blank the panel on the ~850 multi-store titles.
- **The authenticated path harvests details from the public feed too.** Descriptions, screenshots and `supportedControls` exist *only* there, so a signed-in refresh walks both: the session for ownership, the public feed for what a game actually is. That failure is caught separately — it costs the panel, not the catalog.

`CATALOG_CACHE_VERSION` in `src/shared/types.ts` exists for exactly this class of change: a cache written by an older harvest is incomplete in ways nothing can detect at read time, so bump it and let the background refresh replace it.

### Play history — the third store, and the only one that is ours

`userData/recent.json`, behind `src/main/recent.ts`, backing the **Recent** rail item. It exists as its own file for one reason: `refreshCatalog` rewrites `catalog.json` wholesale, so anything hand-added to a `GfnGame` is destroyed by the next network walk. `patchGame` is the only surgical path into that file and it is explicitly a bridge, not a store of record. History has to outlive the catalog, so it lives beside it.

It is written in the `gfn:launch` handler, after a confirmed spawn — one choke point, downstream of the only event that means "a game started". It records `request.gameId`, never `request.cmsId`. `pushRecent` is pure (dedupe, promote, truncate) and unit-tested, in the same spirit as `buildPowerArgv`.

The renderer holds ids, not games: `recentGames` in `App.tsx` resolves them against the catalog and **drops what no longer matches**, because a title can leave the catalog between two runs. Recent is also the one grid view with **no genre strip and no LB/RB cycling** — it is a chronology, not a collection, and filtering it would punch holes in an order the user is reading as "what I played, in the order I played it". `visibleGames` short-circuits on `view === 'recent'` for that reason; a filter added there has to be hidden too, or the strip will lie.

### How the owned-games list actually works

The user does **not** add owned titles one by one. The model is *link once, sync many*: they link a store account (Steam, Epic, Ubisoft, EA, GOG, Xbox) and GFN pulls that store's whole library. When a title later enters the GFN catalog and the user already owns it on a linked store, it appears automatically.

`POST /v1/sync/{providerId}` is what GFN's own "Refresh library" button calls — it forces an immediate resync instead of waiting for the periodic one. `library:syncAll` fires it at every provider that is `linked` **and** `canSync`, and the Settings row then waits `SYNC_SETTLE_MS` before reloading the catalog: a 202 says the request was taken, not that the library is current, so there is nothing to await and the wait is GFN's own `defaultSyncWaitInterval` rather than a guess.

**Linked is not the same as syncable.** `AccountLinkingSso` and `AccountGamesSyncing` are separate members of the `features` union on `appStoreDefinitions`, and a store can support the first without the second — Epic does, which is *why* Epic games have to be marked by hand rather than an oddity beside it. GFN's own client checks `isAccountSyncingSupported` before it asks; the launcher did not, and the store answered 400 on every refresh while the others succeeded, so the row reported success and the log carried the failure. `readSyncableStores` in `library.ts` now reads that flag alongside the provider list, the Settings badge says `no sync` instead of a `0 synced` that would never move, and a store missing from the answer is assumed syncable — losing this query must cost a refused request, never a store that quietly stops.

There *is* also a manual override: `mutation AddOwnedVariant(variantId, language)` (and `RemoveOwnedVariant`, `SelectOwnedVariant` to choose which store's edition launches), wired as `setOwned` and `selectVariant` in `src/main/gfn/library.ts` and surfaced as the store chips in the details panel. It is the escape hatch for what sync misses, not the main path — a launcher that asks people to tag games by hand has misunderstood the product.

**A mutation is not believed until the server accepts it.** `src/main/ipc.ts` runs the mutation first and only then calls `patchGame` in `catalog.ts`, which edits the one entry in the memoised snapshot, rewrites `catalog.json`, and returns the updated game for the renderer to swap in. That write-through is a *bridge*, not a store of record — the change lives on NVIDIA's side and the next authenticated refresh brings it back on its own — but without it a one-field edit would cost a twelve-second re-walk. Only `AddOwnedVariant` is transcribed from the bundle; the other two are inferred and unverified, so failures here are expected rather than exceptional.

### Authentication

The launcher hosts NVIDIA's own web client in a `BrowserWindow` it owns and reads credentials off the requests that window makes (`src/main/gfn/webAuth.ts`). Three other routes were tried and are dead — reusing the desktop client's on-disk token, borrowing GFN's OAuth client, and registering our own. `docs/gfn-api.md` records the evidence for each.

Interception yields the endpoint, the safe headers, the `NV-Client-*` pair **and** `vpcId` (from the POST body, correlated to the headers by `details.id`). Taking them from a real request beats guessing. It does *not* yield a bearer: the web client authenticates GraphQL with session cookies, and `CapturedSession.token` is null on a normal capture. The one credential that has to be fetched rather than overheard is the Starfleet id token ALS needs, read from the page's IndexedDB at the end of the capture.

Three rules this imposes:

- **Never call `ensureSession` speculatively.** A headless capture boots the whole GFN web app and can block for its full timeout. It is gated on the persisted `gfnLinked` flag, which is why every call site reads that flag and passes it. A regression here shows up as the UI hanging on "Loading settings…".
- **Keep provider listing off the first-paint path.** `App.tsx` loads it in a second, non-blocking effect for the same reason.
- **The tokens are memory-only.** The login persists in the browser partition, which is the right place for a cookie jar; neither the bearer nor the Starfleet id token is written to disk, and never into this repo. `readIdToken` returns the one field the launcher needs and drops the rest of the stored session — the access token, the client token and the user's identity — on the floor.

`getSession()` is the synchronous, no-network accessor; `ensureSession()` may open a window. Use the former on any hot path.

**Launching needs no token** — the deep link goes to the local client — so the launcher stays useful signed out: the catalog falls back to the public feed (real ids, so every tile launches), providers return `[]`, sync and `setOwned` refuse with a reason. What is missing without a session is ownership, and therefore the library view, not the ability to play.

Sign-in itself is the one part of the product that is not gamepad-navigable: NVIDIA's login page expects a pointer and keyboard.

### What is fixture data

The catalog resolves in this order: authenticated feed when signed in, public feed when not, disk cache when offline, `src/main/gfn/fixtures.ts` when there is nothing else. **Fixture `cmsId`s are placeholders and will not launch** — the titles are real only so the UI can be judged with realistic string lengths.

Fixtures are therefore the offline-first-run case, not the normal signed-out one. `App.tsx` treats a snapshot with `source: 'fixture'` as a machine that has never fetched anything and pulls the public feed in the background, after first paint.

### Server status — the fourth backend, and the only one that is not NVIDIA's

`src/main/status/`, behind the **Status** rail destination. `status.geforcenow.com` is a stock Atlassian Statuspage; `docs/gfn-api.md` has the endpoint survey and every wire shape. Three things shape the code.

**The nameplate is the feature; the fleet is context.** NVIDIA's page answers "is GeForce NOW up?" — the question on a sofa is "is *my* box up?", and only the launcher can answer it, because only the launcher can read the client's routing configuration off this disk. So the screen opens with one datacenter and the other 75 come after.

**The zone match is exact, offline, and needs no second request.** `remoteOverrides.metaData.zoneName` in the client's `sharedstorage.json` *is* the Statuspage leaf name — the client says `NP-FRK-08`, the page calls that component `NP-FRK-08 [RTX 5080]` — so `resolveZone` strips the tier suffix at map time and compares strings. `prod/v2/serverInfo` would resolve an Auto region authoritatively and is unauthenticated, and it is deliberately **not** on this path: it only earns a request when there is no `zoneName` at all, and then the honest answer is "stream once and we'll know".

**`sharedstorage.json` contains a live bearer token, an `idToken` JWT with the user's email, and the machine's MAC address.** `parseZoneAssignment` reads three subtrees and returns six declared fields. Never log the parsed root, never widen the return type to "whatever was in there", and keep the key-set assertion in `zone.test.ts` — a fixture full of secrets in, six facts out, is the only thing standing between that file and the renderer.

Two departures from house convention, both deliberate:

- **The cache is memory-only.** Every other store here persists, and this one must not: a catalog from last week is merely incomplete, a status board from last week says "all systems operational" about a datacenter that is on fire. A 41 KB payload behind `max-age=10` with ETag revalidation makes a cold fetch cheap, and the half that matters most — region, zone, routing, latency — is read from a local file and works offline anyway. `STATUS_TTL_MS` serves the cached board for a minute so that leaving the view and coming back is navigation, not a refetch.
- **It is the one `fetch` in the repo with a timeout.** `AbortSignal.timeout(8_000)`. Elsewhere a stalled request costs a background walk nobody is watching; here it costs a spinner on a button the user just pressed, on a screen with no keyboard, and a control that never finishes is the failure nobody can diagnose. A second timeout added somewhere should cite this precedent — otherwise it is drift.

**This screen is the documented exception to the one-colour rule.** Health gets hues, on two conditions that are the whole reason it is allowed to.

*The colour is on the dot, not on the row.* `HealthMark` paints a solid dot from `--status-ok` / `--status-info` / `--status-warn` / `--status-alert` / `--destructive` (reused, rather than a second red), all held at lightness 0.72–0.80 so no state is louder than its neighbour for reasons other than its hue. Labels stay `muted-foreground` for the two states that need no action and take the hue only for the three that do — 36 healthy regions rendered as 36 green *words* would mean the one red word had to shout over them instead of standing alone.

*It is confined to this screen.* Nothing outside `src/main/status/` and `StatusScreen`/`HealthMark` may use the `--status-*` tokens. The reason the rest of the chrome is colourless is that cover art has to be the most saturated thing on screen; this view has no cover art on it and has 76 datacenters, where telling "fine" from "degraded" from "down" by fill and weight alone stops working somewhere past the first dozen rows. Put a status hue on a tile, a rail item or the footer and that argument stops holding.

The **Yours** badge on the user's own region is `bg-primary` — the accent, on the one row out of thirty-six they came here for. It is the same colour as the focus ring, so it only competes with the cursor when the cursor is already on that row.

`status:refresh` is the view's landing target, so A on arrival re-checks. The nameplate and the summary line are not focusable — they are the answer, not controls — and the region and incident rows are focusable partly because expanding them is useful and partly because a screen with one focusable cannot be scrolled with a pad.

**The nameplate is also pushed, not only pulled.** The user changes their server location in the GeForce NOW app, so the launcher is behind them when it happens and a screen left open on a sofa would keep naming the region they left. [The client watch](#following-the-client-while-it-changes) sends the zone alone over `status:zone`, resolved against the board this module already holds — so it costs no request — and the renderer merges it into the snapshot it has. Only the zone: the rest of that board has its own freshness and its own error, and synthesising them here would make a stale fetch look like a fresh one.

## Design

Console-like, not desktop-like: a television interface in its own right, rather than a web app scaled up.

**The shell is colourless so the games are not.** Stock shadcn `neutral` dark, and the only chromatic thing in the entire chrome is the accent — which paints the focus ring, the primary button, the RTX filter, and nothing else. Every cover in the grid is therefore the most saturated object on screen, which is the right answer for a screen whose whole job is showing you games. A second colour to mean something is not the tool; use weight, a border, or an icon.

**The first exception is the server-status screen**, which paints service health in green/blue/amber/orange/red. It earns it by being the only view with no cover art on it and 76 datacenters in a list, where fill and weight stop separating "fine" from "degraded" past the first dozen rows. The `--status-*` tokens are confined to `HealthMark` and `StatusScreen`.

**The second is the Support icon in the nav rail**, which wears `--support` — a deep red, deliberately not the bright `--destructive` one, so a standing donation prompt never reads as a fault. It is the only destination in the rail that asks the user for something rather than offering them something, and the hue is what says so without a line of copy. Two constraints keep it from reopening the rule: it is *one icon*, not a row or a fill, and it keeps the colour through focus and selection — `NavButton` takes an optional `tint` that overrides the grey/white state pair, so the ring, the `bg-accent` fill and the label brightening remain the only things that move when the cursor arrives. The token is confined to that item.

**RTX is the one thing besides focus allowed to wear the accent, and it still loses to focus.** The `RTX ON` chip in `GenreStrip` is accent at rest, but as an *outline* — `border-primary/70 bg-primary/10 text-primary` — so the focused state has somewhere brighter to go and keeps the solid `bg-primary` fill every other chip gets. The tile badge is accent *text* on a dark blurred pill rather than an accent fill, for the same reason at grid scale: ninety solid accent pills would out-shout the one ring that is the cursor.

**The accent is the user's, not ours.** `ACCENT_PRESETS` in `src/shared/theme.ts` is the whole vocabulary — seven presets, all at lightness ≥ 0.80 so a single dark `--primary-foreground` is always readable and focus stays the brightest thing on screen. `Settings.accentColor` stores the **id**, never the colour: the value lands in a CSS custom property, and an id is what stops a hand-edited `settings.json` from injecting arbitrary CSS. `sanitise()` in `src/main/settings.ts` validates it against the same list. The renderer pushes `--brand` onto `document.documentElement`; `globals.css` already declares white there, so nothing flashes before settings arrive.

`UI_SCALE_PRESETS` beside it is the same pattern for the same reason — five steps from 75% to 175%, `Settings.uiScale` stores the id, `isScaleId` guards `sanitise()`. Only the mechanism differs: main applies it with `setZoomFactor` rather than the renderer setting a custom property, because zoom catches border widths and ring offsets that no rem multiplier reaches. **Anything added to `Settings` needs its own branch in `sanitise()`** — it is an explicit allow-list, so a field without one is silently dropped on every read *and* every write, which reads as "my setting does not save".

**Focus is the only cursor in the room, so it is a ring with an offset.** The `focus-ring` utility in `globals.css` is the one custom utility left, and it exists because focus here is virtual. Anything focusable must paint it.

Because that ring is drawn *outside* the element — and focused tiles also scale up — **every scroll container holding focusables needs padding plus a matching `scroll-p-*`**. Padding alone only helps the first row: `focus()` calls `scrollIntoView({ block: 'nearest' })`, which parks an element flush against the viewport edge and shears the ring off. Note also that `overflow-x-auto` on its own makes a container clip *both* axes, which is why the genre strip and the screenshot strip carry vertical padding they otherwise would not need.

**Hierarchy is size and weight, and the root scales.** Geist has no width axis, so `html { font-size: 20px }` does the 10-foot work in one line and every rem-based Tailwind utility follows. That line used to be `clamp(16px, 1.05vw, 20px)` and **must not go back to `vw`**: interface size is a user setting applied as `webContents.setZoomFactor` (`src/main/uiScale.ts`), and zoom shrinks the CSS viewport by exactly the factor it magnifies by — so a `vw` term is invariant under it and the clamp cancelled the user's choice outright between 100% and ~130%, leaving the type the one thing on screen that refused to grow. Anything still sized in `vh`/`vw` — the hero band's `h-[34vh]`, the `clamp(…, 4.5vw, …)` headings — stays a proportion of the *screen* at every scale, which is the right answer for those and a trap for anything else. Write plain Tailwind (`text-2xl font-semibold tracking-tight`, `font-mono text-xs tabular-nums`). Fonts are self-hosted via `@fontsource-variable` — the launcher starts at boot and must render correctly offline.

**Artwork is scrimmed, never bare.** The hero band and the details panel both paint cover art under two gradients — one horizontal for text legibility, one vertical to dissolve the band into the grid. This is not decoration: unscrimmed 1920×1080 art would out-shout the focus ring. Every image falls back to `placeholderGradient`/`placeholderBackdrop` in `src/renderer/src/lib/artwork.ts` on a null URL *or* a failed load, so a title without art still looks deliberate. Those placeholders are **neutral**, varying only in lightness off a hash of the title: inventing a hue per title would put more colour in an empty tile than there is in the whole interface.

The screenshot viewer (`ScreenshotViewer.tsx`) is the **one** exception, and only because it earns it: there is nothing else on that layer to point at, so no cursor to lose, and scrimming would be dimming the entire subject. Everywhere a focusable sits beside artwork, the artwork loses.

**Genres are shown through `genreLabel`, never raw.** The catalog returns twenty `SCREAMING_SNAKE` codes; `src/shared/games.ts` maps them, abbreviating the ones that are a paragraph at three metres (`FIRST_PERSON_SHOOTER` → `FPS`) and title-casing anything new. There is no `HORROR` and no `ROGUELIKE` — the vocabulary is exactly those twenty, which is also why `fixtures.ts` uses real codes rather than invented ones.

**There is no top bar.** Above the footer the screen belongs to cover art, starting at the first pixel — a TV renders a picture better than it renders chrome. All of the launcher's own state lives in one strip along the bottom: `StatusFooter.tsx` carries the button legend on the left and connection state (`ready` / `absent` / `handoff` / `failed`) plus both version numbers on the right, with `LoadingBar` as a 2px hairline directly above it and `LaunchNotice` above that. The GFN client version is unlabelled because it hangs off the `GFN CLIENT …` line and reads as part of it; the launcher's own is labelled `LAUNCHER v…` and sits last, since two versions in one strip have to say which program each belongs to and this is what a bug report asks for first. It comes off `UpdateStatus.currentVersion` rather than a channel of its own — see the update section for why main answers that whether or not the check may touch the network — so it appears a moment after the rest of the footer and the item is simply absent until then. This replaced an animated `SignalTrace` across the top; something new competing for attention up there should be cut rather than escalated.

**`LaunchNotice` is where a failed launch goes, and it obeys all three rules at once.** Bottom-anchored, so it never covers artwork; **colourless**, distinguished by a `TriangleAlert` and `text-foreground` weight rather than a hue, because `--status-*` belongs to the status screen and the accent belongs to focus; and **not focusable**, so it stays out of `SpatialFocus` entirely — nothing on it is a control, there is no scope to activate and no focus to hand back, which is also why it auto-dismisses instead of carrying a dismiss button. It shows a sentence from `launchFailureReason` plus the failing argv, because "spawn flatpak ENOENT" names the fault exactly and explains nothing to somebody on a sofa. Before it existed a failed launch only reached `console.error`, and the footer went on saying `HANDING OFF` for the full 2500 ms — the launcher's own worst-case failure, a control that silently does nothing.

Tokens live in `src/renderer/src/styles/globals.css`. Use the semantic ones (`bg-background`, `text-muted-foreground`, `border-border`, `bg-primary`) — a literal colour in a component is a colour the accent switch cannot reach.

## Support

A sixth rail destination whose whole content is a thank-you and a QR code. The donation link was already in `README.md` and in the AppStream `<url type="donation">`, which between them reach people browsing a repository and people browsing a software centre — and nobody who installed a bundle and drives the result from a sofa. The rail is where that person looks. It sits last, above the rule, because it is the only destination that asks the user for something rather than offering them something, and it should never be on the way to anywhere.

**The QR is the feature and the browser is the fallback**, which is the inverse of how this normally goes. `DonateScreen.tsx` renders the code at `15rem` — cover-art scale — and makes it the only focusable on the page. Confirm hands the URL to the desktop through `app:openDonation`, for the machine that happens to have a browser; on a television that press does nothing useful and the code is the entire answer.

**That channel takes no argument, and that is the point.** Everywhere else on this boundary the renderer sends a value and main validates it; here both sides import `DONATION_URL` from `src/shared/donate.ts`, so nothing crosses and there is nothing to forge. It is deliberately *not* `openExternal(url)` with a host allow-list bolted on. Do not widen `setWindowOpenHandler` in `main/index.ts` to serve this either — that one forwards an arbitrary URL with no scheme check, and it exists only as a guard against a `window.open` that should never happen. `donate.test.ts` pins the protocol, the host and the button id: a QR encodes whatever it is given, and nobody proofreads a matrix of black squares.

On Linux `shell.openExternal` is `xdg-open`, which on a machine with no registered http handler can exit 0 having done nothing. A rejection is surfaced under the code; a silent no-op cannot be. One more reason the code, and not the button, is the primary path.

**It is the only centred composition in the launcher.** Every other screen is a tool — content flush to the rail, a list or a grid. The header stays left-aligned so the page is unmistakably part of the app; everything below it is a plate. The code is also the brightest object on screen, which inverts the rule that cover art always wins: there is no cover art here, and the thing to look at is the code.

## Power

The launcher is the last thing on screen before the TV goes off, so it can end the session: nav rail → Power → Back to desktop / Sleep / Restart / Turn off. `src/main/power.ts` shells out to `systemctl <verb>` with `execFile` — the same three verbs every desktop environment calls, mediated by logind and polkit, needing no native D-Bus module (`npmRebuild: false` and `externalizeDepsPlugin` would make adding one a build-config problem). `buildPowerArgv` is pure so the argv is unit-tested without ever suspending the machine running the suite.

Nothing here is privileged, and the channel validates the action against the union before it becomes an argument to `systemctl`. A refusal comes back as an error the dialog shows: on a screen with no keyboard, a button that silently does nothing is the one failure nobody can diagnose.

**"Back to desktop" shares the dialog and nothing else.** It is `app:minimize`, not a `PowerAction` — every value in that union becomes an argument to `systemctl`, so a row that ends nothing must not be able to reach it, which is why `PowerDialog` renders it above `CHOICES` and a `Separator` rather than inside the array. `stepAside()` in `src/main/window.ts` **drops fullscreen before minimising**: on Linux an iconify request aimed at a fullscreen surface is one many window managers, and every Wayland compositor, are free to ignore, and the launcher would silently stay on top of what it was stepping aside for. `gfn:open` is the only other caller; launching a game deliberately is not one. Coming back at all needs a mouse or keyboard — a minimised launcher is one `shouldAcceptInput` ignores, and one no pad could un-iconify in any case — and the row's own description says so.

**`holdFullscreen()` covers the way back that is not ours.** `stepAside` leaves fullscreen before it minimises, and `restoreLauncher` puts it back — on the four ways back that go through this process. The fifth does not: clicking the launcher in the taskbar is entirely between the user and the compositor, so the window reappeared at 1600×900, and with no keyboard in the room there was then no way to make it fullscreen again. The launcher was a desktop app from that moment on. So `createWindow` attaches a listener to **both `restore` and `show`** — the two packaged forms do not agree on which arrives, since un-iconifying emits `restore` and a surface Chromium re-presents under Wayland emits `show` — and it re-reads `Settings.fullscreen`. It only ever *enters* fullscreen: the setting means "come up fullscreen", and somebody who pressed F11 on a keyboard has said something more recent than a setting.

The other half of that fix is that **the Settings toggle now applies immediately**, through `setFullscreen` in the same module, for the reason `applyUiScale` does — plus one of its own. There is no F11 on a sofa, so that row is the only fullscreen control a gamepad can reach, and a launcher that ended up windowed for any reason had no way out of it.

**`restoreLauncher()` lives beside it, and is a sequence rather than a `focus()`.** Four callers — `ready-to-show`, `second-instance`, the web-stream window closing, and the handback watch — which is why both helpers moved out of `ipc.ts` into `main/window.ts`. On X11 `focus()` is the whole answer; under Wayland it is a request the compositor may refuse, because raising and focusing needs an xdg-activation token, only the client currently holding input can mint one, and Electron exposes no way to carry it. So: un-iconify **and wait for it** (`restore()` is a request, and `setFullScreen` aimed at a still-minimised surface is dropped), `show()` as well, because mapping a surface is the one moment a compositor will focus a window without a token, fullscreen re-applied **from settings** or a window restored from the taskbar comes back at 1600×900 and the launcher is a desktop app from then on, then `setAlwaysOnTop`/`moveTop` — **X11 only**, and transient, because leaving it on would put the launcher over the GFN window on the next launch — and `focus()` last. None is guaranteed; between them they cover every session this runs in, and the compositor has to give focus to *something* when the window that had it disappears.

`hide()` instead of `minimize()` was considered and rejected. A hidden window's `show()` is an unambiguous surface map and materially more reliable under Wayland, but a hidden window is in no taskbar and no alt-tab, and `second-instance` keys on `isMinimized()`. The failure policy everywhere here is "degrade to the status quo ante"; `hide()` degrades to worse than it.

**Keeping the screen on is, though, and it has to be asked for.** A joystick is not seat input, so a compositor's idle timer runs straight through a browsing session: the sticks move, the launcher responds, and the television blanks anyway. `usePadWakeLock` in `src/renderer/src/gamepad/wakeLock.ts` reports input over `app:padActivity` — throttled to one message per `PAD_ACTIVITY_PING_MS`, because holding a direction emits an intent every 90 ms — and `createDisplayWakeLock` in `src/main/displaySleep.ts` holds a `prevent-display-sleep` blocker while `shouldStayAwake` says so. That predicate is pure and lives in `src/shared/wakeLock.ts` beside the two intervals, which have to agree: report far more often than the claim expires, or a pad that never stopped moving would lose the display between two reports.

**The claim follows input, not a connected pad**, which is the simpler rule and the wrong one — it would leave a bright, static grid on a television all night. It also lapses on blur rather than waiting out the timer: once the GeForce NOW client has the screen, the screen is its problem. That release is now prompt as well as correct — `createDisplayWakeLock` listens for `browser-window-blur` instead of leaving it to the next `CHECK_INTERVAL_MS`, which matters more than it used to: the renderer stops reporting pad activity when it stops answering the pad, so nothing else would arrive to re-evaluate the claim. Note that on Linux this reaches `org.freedesktop.ScreenSaver` and therefore defers the automatic lock while held; that is why it is five minutes and not a permanent inhibit, and why it is worth reading next to the paragraph below, which refuses to touch the lock screen at all.

`powerSaveBlocker` rather than the renderer's Screen Wake Lock API: a page wake lock lasts as long as the document is visible, and this document is always visible.

**Waking the machine with the pad is not something the launcher can do.** `/sys/bus/usb/devices/*/power/wakeup` is root-owned; it takes one udev rule, documented in [docs/wake-on-gamepad.md](./docs/wake-on-gamepad.md). Settings used to carry a card pointing at that file; it was static text with no control in it, so it is gone and the doc is the only pointer left. Privilege escalation is not on the table for this.

## Updating itself

`src/main/update/`, behind an **Update** notice and the last Settings section. The launcher checks GitHub Releases once per start and installs the new version where installing it is the launcher's job.

**Three install forms, three owners, and that is the whole design.** A Flatpak is updated by `flatpak` on the host. An AppImage is one file with nobody responsible for it, which is why it is the only one this process overwrites. A `.deb` belongs to a package manager that needs root, and root is not on the table here — the same answer this project already gives to waking the machine with a gamepad. So `resolveUpdateChannel` is a pure function over four environment facts, and `UpdateStatus` keeps **`available` and `canApply` as separate fields**: every form can be *told* about a release, and only two can act on one. Conflating them would either hide the news from `.deb` users or hand them a button that cannot work.

Note the branch order in `resolveUpdateChannel`, which is not arbitrary. Unpackaged is checked first, because `npm run dev` inherits neither marker and would otherwise read as a `.deb`. Flatpak is checked before AppImage, because a Flatpak launched from a terminal that came from an AppImage inherits `APPIMAGE`; `/.flatpak-info` cannot be inherited.

**GitHub Releases rather than a manifest of our own.** The release workflow already publishes all three artefacts there with a sha256 digest per asset, and a second place to publish a version number is a second place for it to be wrong. `LATEST_RELEASE_API_URL` and `LATEST_RELEASE_PAGE_URL` live in `src/shared/update.ts` and are imported by both sides, exactly like `DONATION_URL` — the QR code on the notice is drawn from the constant rather than from anything main handed over, so nothing crosses the bridge and there is nothing to forge. `update.test.ts` pins the host and the repository for the same reason `donate.test.ts` pins the button id.

**Version comparison is full semver, and the pre-release rule is why.** `0.2.0-beta.1` is *older* than `0.2.0`, so a three-number compare would offer a beta as an upgrade over the stable build it precedes. `/releases/latest` excludes pre-releases, which makes that unreachable today and would make it a silent regression the day this is pointed somewhere else. `isNewerVersion` also refuses an unparseable candidate and refuses to go backwards, so a development build made after the last release is never told to downgrade.

Four things about the two install paths:

- **The Flatpak path compares deploy commits, not output.** `flatpak update` prints "Nothing to do." *on the host, in the host session's language* — the same trap `classifyHostFailure` refuses to fall into. It also exits 0 having done nothing, which is the normal outcome for anybody who installed the `.flatpak` bundle by hand rather than from a remote. So `applyFlatpak` reads `flatpak info --show-commit` before and after, which is exact and locale-independent, and reports honestly when nothing moved.
- **Nothing is installed unverified.** `download.ts` hashes the bytes as they arrive and compares against the asset's digest; a missing or malformed digest refuses outright. The swap is a `rename` from a sibling temporary file, so it is atomic and the path never holds half a download — and replacing a *running* AppImage that way is safe, because the runtime holds its mount on the inode. Every failure path deletes the temporary and leaves the machine exactly as it was.
- **It is the second `fetch` in the repo with a timeout**, and it cites `statuspage.ts`, which documents itself as the first. The download's is an *inactivity* timeout rather than a total one, which is the one difference: `AbortSignal.timeout` aborts the body too, and any total figure generous enough for 130 MB on a slow line is far too long to notice a dead connection.
- **Both paths report progress, from different things.** The AppImage counts its own bytes. The Flatpak path cannot — `flatpak` is doing the transfer — so `scanFlatpakProgress` reads the percentage out of its output, which is why `UpdateProgress` carries `percent` beside the byte counts and why the byte counts are zero on that path. The notice shows megabytes when it has them and the bare percentage when it does not; two numbers saying the same thing is one more than anyone reads from a sofa.

### Reading `flatpak update`, and restarting into it

Both of these were established from real runs against flatpak 1.18.1, not inferred, and `flatpakProgress.ts` carries the captured output as its fixture.

**`--assumeyes`, not `--noninteractive`, and the difference is the progress bar.** `--noninteractive` selects flatpak's quiet transaction, whose entire output for a 19 MB pull is one line naming the ref. `--assumeyes` prints one line per progress update — `Installing… ██████████████▊       74%` — and with stdout piped and **stdin at `/dev/null`** it still completes unattended, which is what the original flag was there to guarantee. Measured both ways round.

**Only the digits before a `%` are parsed.** Everything else on those lines is a locale trap of the kind this codebase already refuses: the verbs are translatable, and the size and speed come from `g_format_size` in the host session's language — the captured fixture reads `19,4 MB`, on an Italian host. The percentage comes from a plain `%3d%%`. Not reading the verb is also what makes the parser indifferent to install vs update vs uninstall. Completion is *not* read from here either; the commit comparison above is what decides that.

**`hostExecStreaming` exists for this one caller.** `hostExecFile` buffers to completion, which is right for everything that answers in milliseconds and useless for a command that runs as long as a download. It sends both streams to the callback, because which one flatpak writes progress to is not a contract, and it pins stdin to `/dev/null` for the reason above.

**A Flatpak restarts through the host, because it cannot restart through itself.** `flatpak update` deploys a new commit while the running sandbox keeps the old one bind-mounted, so `app.relaunch()` — which re-execs `process.execPath` inside that sandbox — comes back on the version it started with. `buildFlatpakRelaunchArgv` hands the host a shell that waits for this instance to leave `flatpak ps` and then runs `flatpak run`, which mounts the new deploy. Three details, each load-bearing:

- **It waits rather than sleeping a guessed number of seconds.** Guessing short is the worst failure this feature has: the new instance finds the old single-instance lock still held, quits, and a television is left with no launcher. The wait is bounded at 30 seconds, and timing out is safe — `flatpak run` then refuses against a launcher that is still alive, which is the status quo ante.
- **The command backgrounds itself**, so the outer shell returns in about two milliseconds. Without that, `flatpak-spawn` — a process *inside our sandbox* — would sit waiting for its host child, the sandbox could not tear down, the instance would never leave `flatpak ps`, and the loop would be waiting for itself.
- **The spawn is awaited before `app.quit()`**, and that is a race rather than a style preference. When the last process in a sandbox exits, bwrap tears the namespace down and kills what is left in it, so quitting immediately after spawning could kill `flatpak-spawn` mid-D-Bus-call and the restart would simply never happen. Waiting also gives a revoked host permission somewhere to be reported, and `restartIntoUpdate` returns false rather than quitting a launcher that has no way back.

`isFlatpakAppId` guards the one value on that path that is not a literal in this repository: `FLATPAK_ID` is an environment variable, and it is interpolated into `sh -c`. `host.ts` avoids shells elsewhere, and that reasoning does not transfer — it was avoiding shell *quoting* of multi-line file content, where this needs sequencing that `flatpak-spawn` cannot express.

**The restart is counted out loud.** `RESTART_COUNTDOWN_S` in `App.tsx` gives ten seconds, ticked one at a time so the number on screen changes: this is the launcher taking the screen away from somebody who may have pressed the button and walked off, and a silent wait before the window vanishes is indistinguishable from a crash. It is not a second confirmation — installing was the confirmation — and closing the notice cancels it, because a launcher that restarted after the notice had gone would look like a fault.

**The notice opens once per version and never over anything.** It waits for the catalog to be on screen and for no overlay to be up, because a modal over a half-drawn grid reads as an interruption rather than as news. "Not now" writes `Settings.dismissedUpdate`, which is what stops the popup being a thing that appears on every start until you give in — the behaviour that makes people turn update checks off entirely. `Settings.updateCheck` turns the automatic check off outright, and **main honours it, not the renderer**: with it off `getUpdateStatus` answers out of what it already knows and touches no network, so the Settings nameplate still has a version to print, and `force` overrides it because somebody who pressed "Check for updates" has asked plainly.

**`update:progress` was the first channel to go main → renderer**, and it set the shape the other three follow. The preload exposes it as `onProgress(listener)` returning its own unsubscribe rather than as a generic `on(channel, …)` — the same rule that keeps a generic `invoke` off that object. The listener is handed the payload alone: `IpcRendererEvent` carries a `sender`, and a live handle reaching the renderer would undo the arrangement.

**The changelog is now read by the launcher, not only by GitHub.** `summariseNotes` takes the **bold lead** of each changelog bullet when it is long enough to stand as a sentence, because that lead is already the three-metre version somebody wrote by hand; a short bold lead is a *label* ("Recent", "Details panel") and falls back to the whole line, since a list of nouns is a table of contents rather than news. It stops at the first `## `, which is the install section CI appends, and prefers to cut on a full stop so that four stacked ellipses do not read as a launcher that could not finish a thought. This is a real constraint on `CHANGELOG.md`: the first sentence of an entry is what ends up on a television.

The notice itself is the launcher's **second** modal and deliberately copies the first. `UpdateDialog` is a shadcn `Dialog` with Radix's focus handling neutralised exactly as `PowerDialog` does it, for the same reasons — focus here is virtual, and B and Escape have to close through one path. Two modal idioms is one more than a ten-foot interface can teach. It is colourless like everything outside the status screen; the accent appears on the focus ring and on the download bar, where `LoadingBar` has already established what it means. Where the launcher cannot install for you, the QR code is the answer rather than a button — the same idiom the details panel and the Support screen use for a link that has to leave the television, drawn larger here because on that branch it *is* the action.

## Autostart

XDG `~/.config/autostart/gfn-launcher.desktop`, written by `src/main/autostart.ts` rather than Electron's `setLoginItemSettings` (a thin, inconsistent wrapper on Linux; a plain desktop file is inspectable and fixable by hand). Inside an AppImage the mounted exe path is temporary, so `process.env.APPIMAGE` is the only stable `Exec=` target. The desktop entry — not `settings.json` — is the source of truth for whether autostart is on.

**`StartupNotify=true` is what makes an autostarted launcher come up focused**, and it is the whole of the fix — there is no main-process code that substitutes for it. With it the session mints a startup id, an `XDG_ACTIVATION_TOKEN` under Wayland, which Chromium consumes for the first window and the compositor honours. Without it there is no token, a Wayland toplevel cannot activate itself, and `focus()` in `ready-to-show` is a request KWin's focus-stealing prevention is entitled to decline — leaving the launcher at the front of a fresh session with no keyboard, no display wake lock and no claim on the screen. It does **not** leave it unable to answer the pad, and that is the fourth row of the input table above doing its job rather than luck — a focus-only gate would have turned every entry written before this line existed into a dead television. The *installed* entry has always carried it; the one written here did not, which is why `autostart.test.ts` now pins it. `StartupWMClass` deliberately does not follow: it differs per packaging and a wrong value is worse than none.

The entry filename stays `gfn-launcher.desktop` rather than matching the installed `io.github.robertotucci.GfnLauncher.desktop`. Renaming would orphan every entry already on disk and leave a second one starting a second instance — survivable, thanks to the single-instance lock, and churn for nothing.

Note what autostart is *not*: a way to boot straight into the launcher with no desktop behind it. That needs a dedicated session, and the launcher deliberately does not want one — "Back to desktop" needs a desktop to go back to. Inside a session the shell starts before XDG autostart entries run, so a second or two of visible desktop is structural.

## Diagnostics

Every other failure surface in this codebase is on screen and lasts seconds — `LaunchNotice` for eight, the power dialog until it is dismissed, the footer while the condition holds. That is the right shape for the person in the room and the wrong shape for the person reading a bug report a week later, so `src/main/log.ts` writes the same events to a file that outlives them.

The file is named in the README, printed at the bottom of **Settings → This launcher**, and printed again on the crash screen. Naming it in three places is deliberate: a report that has to begin with "which file do I attach?" is one most people do not begin.

**`console` is patched rather than replaced.** There were already twenty-odd `console.warn`/`console.error` calls, each at a point somebody had decided was worth reporting, and introducing a second logging vocabulary would have meant converting them and then policing which one new code uses. Patching keeps every existing site, every future one, and Electron's own output going to the file for free, and leaves `console.error` meaning exactly what it already meant. The terminal copy is untouched, so `npm run dev` behaves as it did.

**The renderer arrives through `console-message` on the `WebContents`, not through a channel on the bridge.** The preload surface is an explicit allow-list on purpose and a diagnostic is not a good enough reason to widen it — and this route also catches messages from *before* the bridge exists, which is precisely when a preload fault shows up. Lines are tagged `main` or `gui`, because "the grid threw" and "the catalog walk threw" read identically without it.

**Every line is redacted on the way to disk.** `redactSecrets` removes JWTs, `Bearer`-style credentials while keeping the scheme, `accessToken`/`idToken`-shaped key–value pairs, email addresses and MAC addresses. This is belt and braces rather than the only defence — `parseZoneAssignment` returns six declared fields and `streamLog.ts` logs offsets rather than chunks — but it is what makes the README's request safe to make. It deliberately leaves file paths alone: half the failures worth reporting are a path that could not be read. `log.test.ts` asserts both directions, including that a reverse-DNS application id survives, since the obvious three-dotted-segments pattern would have eaten `io.github.robertotucci.GfnLauncher` out of nearly every interesting line.

**Writes are synchronous.** A buffered stream loses its tail on exactly the failures the file exists to explain — a crash, an OOM kill, the `poweroff` the user just asked for from the power menu. One `writeSync` per line costs nothing at this volume, and the last line before the process died is the one worth having. One megabyte, one generation of history.

What is logged is chosen rather than exhaustive, on the principle that a file nobody can skim is a file nobody reads: start-up and install form, the client probe, every launch with the resolved path and the exact argv, every phase transition of the session watch, what `restoreLauncher` asked for **and what it got**, host commands that failed or took over two seconds, and the update flow either side of the commit comparison. The probes in between — one every one to ten seconds for the length of a session — are not logged at all.

### Failures that used to have nowhere to go

Four additions, all of them cases where the launcher's own reporting could not reach:

- **An uncaught exception in main no longer ends the process.** Node's default is to exit, and on a television that is a launcher that vanishes with no window and no message. A degraded launcher is strictly better than an absent one, and most of what runs in that process is a background refresh.
- **A dead renderer is reloaded, at most three times.** `render-process-gone` otherwise leaves a black rectangle that a gamepad cannot act on. It is bounded because a renderer that dies on every paint would loop forever, and a visible crashed view is at least something somebody can photograph.
- **A React error is caught by `ErrorBoundary`, which sits outside both providers in `main.tsx`** — either of them can be the thing that threw, and a boundary below them would be unmounted along with the tree it was meant to replace. `CrashScreen` therefore depends on neither: its "press anything to reload" is fifteen lines of its own `keydown` listener and `requestAnimationFrame` poll rather than the launcher's input stack, which is the stack least entitled to be assumed working. It offers the reload rather than performing it, because an automatic one on a deterministic fault is a launcher that flickers forever and can never be photographed.
- **A throwing intent handler no longer kills the pad.** `emit` is called from inside the `requestAnimationFrame` tick, so an exception used to propagate past the `requestAnimationFrame(tick)` that would have scheduled the next frame — every input dead for the rest of the session, with no keyboard in the room to recover with. Handlers are isolated and the next frame is scheduled in a `finally`.

### Writes that cannot leave half a file

`atomicFile.ts` — write a sibling, `fsync` it, `rename` over the target — backs `settings.json`, `recent.json`, `catalog.json` and `details.json`. This is not general caution: **the launcher has a power menu**, so `poweroff` landing mid-write is a documented feature of the product firing during ordinary use rather than a hypothetical. A truncated `settings.json` reads as no settings at all, because `sanitise` falls back to `DEFAULT_SETTINGS` on a parse error, and the user experiences it as every preference silently reverting. The `fsync` is load-bearing: without it the rename can reach the disk before the bytes do, which leaves the directory entry pointing at a file of zeroes — worse than the truncation, because the old copy is gone too.

`updateSettings` also serialises its writes through a promise chain. Without it two changes in quick succession lose one of them, and the launcher makes that easy: `setAutostart` is a host call taking hundreds of milliseconds inside a Flatpak, and the user can walk down the Settings screen flicking rows the whole time. A write that fails is logged and **not** rethrown — the change is already in the memory cache, so it holds for the session and merely does not survive a restart, which is a far better failure than a rejected promise crossing the bridge as a toggle that does nothing.
