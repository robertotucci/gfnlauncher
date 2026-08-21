# Contributing

Thanks for looking. This is a small, opinionated project: a gamepad-only launcher meant to be read from three metres away. Most of the surprising code is surprising for a reason, and [ARCHITECTURE.md](./ARCHITECTURE.md) records those reasons — it is worth skimming before a first change.

## Setup

Requires Node 22 or newer and a gamepad. Linux only.

```bash
npm install
npm run dev
```

A keyboard mirrors the pad for development: arrow keys move, `Enter` is A, `Escape` is B, `/` is search, `Tab` is settings, `F1` is ☰ (play), `[` and `]` are LB/RB. While the search overlay is open, letter keys type.

Clicking into devtools blurs the window, and the launcher stops answering the pad while another window has the focus. That is `shouldAcceptInput` working, not a fault; click back into the app and the log says `Pad input resumed`.

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
npm run typecheck      # three tsconfigs: node (main), preload, web (renderer)
npm run lint
npm test               # vitest, single run
npm run test:watch

npx vitest run src/main/gfn/launch.test.ts    # one file
npx vitest run -t 'holds the column'          # one test by name
```

`npx shadcn@latest add <component>` lands in `src/renderer/src/components/ui/` (excluded from lint).

**There are three renderer pages.** `src/renderer/index.html` is the launcher; `src/renderer/compose.html` is the keyboard that types into windows the launcher does not own — no React, no Tailwind, no state, because main drives it over the bridge; `src/renderer/notify.html` is the overlay that draws notices when the launcher's own window is not what is on screen, and unlike compose it *is* React and Tailwind, because it renders the launcher's own `NoticeStack`. All three are named in `rollupOptions.input`, and a page that is not named there is a page that silently does not ship.

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

**Every constructed argv is a pure function with a test.** `buildPowerArgv`, `buildLaunchArgv`, `buildUrlRoute`, `buildOpenArgv`, `buildFullscreenArgv`, `hostCommand`, `buildDesktopEntry`, `buildFlatpakUpdateArgv`, `buildFlatpakCommitArgv` — and `buildKwinScript`, which is not an argv but is the same bargain: text this process generates for another one to execute. The reason is not purity for its own sake: these produce commands that suspend a machine, kill a process, write a file that runs at login, or replace the running application, and the test suite must be able to assert the exact string without ever executing it. When you add another one, follow the pattern.

**Anything crossing the IPC bridge is validated on the main side.** `isPowerAction`, `isLaunchRequest`, `isAccentId`, `isScaleId`, `sanitise()`. The channel is where the renderer stops being ours, and an unvalidated payload becomes a `TypeError` that crosses as a rejected promise — the one result shape the renderer does not model.

**Failures are surfaced, never swallowed.** There is no keyboard in front of this app. A control that silently does nothing is the only failure the user cannot diagnose, which is why `LaunchNotice` exists, why the power dialog shows polkit's refusal verbatim, and why the footer names a blurred window rather than leaving a pad that has stopped working unexplained.

**The launcher does not act on input it can see but was not given.** Chromium keeps feeding pad data to a blurred window on Linux, so `shouldAcceptInput` in `src/shared/input.ts` is what stops the launcher from being driven behind a game — and `stepPad` is what stops the button you quit that game with from firing when it comes back. Both are pure and both are pinned; read the "Who is allowed to drive the launcher" section of ARCHITECTURE.md before touching either. The rule that keeps them safe is that everything there **fails open**: a focused window is always accepted, and every unknown resolves to "accept", because a pad that has gone dead on a television is worse than a stray press and nobody in the room can recover from it.

**Every way in is gated, not just the pad.** That rule used to mean `shouldAcceptInput`, and it now has three enforcement points, because pointer mode gave the launcher two input sources it did not have before. Pad intents are gated as above. The **DOM is taken out of the pointer's reach** (`pointer-events: none` on the app root) while something else has the screen, because a click — real or injected at the compositor — never passed through `shouldAcceptInput` at all. And the **keyboard mirror is gated too**, which it deliberately was not: the old argument was that an unfocused window receives no `keydown`, and that stopped being true the moment the launcher grew an on-screen keyboard that synthesises them. If you add a fourth way in, gate it, and fail open.

**A preload must bundle to exactly one file.** A sandboxed preload's `require` resolves `electron`, `events`, `timers` and `url` and throws on everything else, so a module imported by two entries becomes a shared chunk and *every* preload dies at load — the bridge with them. `oneFilePerPreload` in `electron.vite.config.ts` fails the build rather than letting that ship; `src/preload/pointer.ts` and `src/preload/compose.ts` both show the way out, a type-only import of `IPC` with channel literals the compiler checks against it. There are three preloads now, and the number is the risk: each new one is another chance to share a module with the other two.

**`src/preload/pointer.ts` is the only entry that imports anything from `@shared` at runtime** — `pointer`, `osk`, `padLayout`, `padFamily`, and whatever those pull in. That is safe only while it stays the only one: `index.ts` runtime-imports `@shared/ipc` and nothing else, and `compose.ts` runtime-imports nothing at all. Before adding a `@shared` import to any preload, check the other two, and remember that `verbatimModuleSyntax` is what makes a `type` import free.

**`src/main/pointer/evdev.ts` has one consumer and must not gain another.** It reads the pad while a game is on screen, which is exactly the situation the rest of this section is about not acting in. Its only outputs are a mode toggle and the portal's `Notify*` calls; there is no path from it to an intent or to `gfn:launch`, and that is a property of who imports it.

**The vocabulary is not the reader.** `src/shared/padLayout.ts` holds the pure half — the evdev codes, `joydevLayout`, `parseCapabilityBitmap`, `XPAD_LAYOUT` and the joydev → W3C translation — and *is* imported in three places, because the browser's own numbering turns out to be joydev's whenever Chromium has no standard mapping for a pad. `src/main/padProfile.ts` reads that vocabulary out of `/sys` and opens nothing. Neither can produce a button press: only `openPadReader` opens a device, and it still has exactly one caller. If you are about to import `evdev.ts` from somewhere new, what you want is one of those two.

**Something the launcher decides on its own and the user has to know is an `Announcement`, not a channel.** `notice:show` is the sixth and last main → renderer push, and the reason it is allowed to be the sixth is that it is the *generic* one — every other push carries a single fact that had nowhere else to go. Adding a notice is a row in that union, a row in `noticeContent` in `@shared/notify.ts` and a call to `notify()`; it is not a component, not a timer and not a seventh channel. The copy lives in that table rather than at the call site because it is read from three metres and therefore gets a test.

**And `notify()` must never be able to take down its caller.** It is reached from inside a D-Bus signal handler and from an `fs.watch` settle, so the one function that touches windows catches and logs. A launcher that fell over because it could not draw a card about a headset would be the wrong way round.

**`src/main/inputWatch.ts` is the second module that follows `/dev/input`, and it is not the reader.** `pointer/evdev.ts` keeps its one-consumer rule; this one *opens nothing* — it watches the directory and reads the names out of `/sys` through `padProfile.ts`, which is the same split that module already documents. If you are adding something that needs to know a controller is there, it goes here or in `padProfile.ts`, never in the reader.

**Branch on `DESKTOP.session`, never on `DESKTOP.id`.** The rule in `desktop.ts` is about a desktop's taste, and it stands. The protocol is a different question — whether a client may place its own window and order it above its peers — and two modules answer it: `window.ts` for the restore ladder, `notify.ts` for the notice overlay's shape. Both fail towards the Wayland answer, because that one is merely wasteful on X11 rather than wrong.

**`console` goes to a file, so write for the person reading it a week later.** `src/main/log.ts` tees every `console.*` call — from both processes — into `logs/gfn-launcher.log`, which is the file the README asks people to attach to an issue. Two things follow. Log the *decision*, not just the outcome: "launching via web [mode=auto, client not installed]" answers a question, "launch failed" does not. And log sparingly on anything that repeats — the session watch fires a probe every one to ten seconds and only its four phase transitions are written down, because a file nobody can skim is a file nobody reads.

**Never log a value read out of NVIDIA's files.** `redactSecrets` runs over every line and takes out tokens, JWTs, emails and MAC addresses, but it is the second line of defence and not the first. `parseZoneAssignment` returns six declared fields, `streamLog.ts` logs offsets rather than chunks, and both of those rules still stand.

**A file the launcher owns is written through `writeFileAtomic`.** Sibling, `fsync`, `rename`. The launcher has a power menu, so a write interrupted by the machine going off is ordinary rather than hypothetical, and a truncated `settings.json` reads as no settings at all.

**Adding a `Settings` field means adding a branch to `sanitise()`** in `src/main/settings.ts`. It is an explicit allow-list: a field without a branch is dropped on every read *and* every write, which the user experiences as "my setting does not save".

**Adding a footer legend entry means adding a keyboard binding.** `ACTION_KEYS` is derived from `KEY_BINDINGS`, so an action with no key bound has its row dropped and the entry vanishes whenever no pad is connected.


## Tests

`npm test` runs 480-odd unit tests with vitest, no DOM environment and no Electron. Everything tested is a pure function, deliberately: parsers over third-party wire shapes (`parseZoneAssignment`, `parseVersion`, `mapApp`, `mapDetails`), the focus scorer (`scoreCandidate`), the QR path builder (`qrPath`), and the argv builders above.

These suites carry a guarantee rather than just coverage:

- **`src/main/status/zone.test.ts`** asserts the exact key set returned by `parseZoneAssignment`. Its fixture contains a session blob, because the real `sharedstorage.json` holds a live bearer token, an `idToken` JWT with the user's email, and the machine's MAC address. That assertion is what stops a widened return type from carrying secrets into the renderer. Do not relax it.
- **`src/main/clientWatch.test.ts`** pins two things that fail *without producing an error*. `deployPointerPaths` returns the two absolute paths the client watch stats for an update; they have to agree with the two `--filesystem=…:ro` grants in the Flatpak manifest, and a wrong one throws nothing, logs nothing and simply means the feature does not exist. `markMoved` pins the two `watchFile` behaviours the obvious implementation gets wrong. A **first sighting of a path that is there is a change**, because `watchFile` stays silent when it arms against an existing path and only calls the listener once something moves — read that as a baseline and exactly one change per path per run disappears, which for a launcher started once and a datacenter changed once is every change there is. And **present→absent is the client being uninstalled** — copy `streamLog.ts`'s `curr.mtimeMs === 0` guard here instead and that transition is swallowed too, leaving the launcher reporting a client that is gone.
- **`src/shared/donate.test.ts`** pins the protocol, the host and the hosted button id of `DONATION_URL`. It is the one string in the launcher that sends someone else's money somewhere, and it is encoded into a QR that nobody can proofread by eye.
- **`src/shared/games.test.ts`** pins `launchMode` defaulting to `native`. `auto` silently degrades to a browser window when a `flatpak` probe fails transiently, which is not what a user who installed the native client asked for.
- **`src/shared/input.test.ts`** pins all four rows of the input gate, and in particular that an unfocused launcher with nothing in front of it still accepts input. Tighten that row and a compositor declining a raise becomes a television nobody can drive. **`src/renderer/src/gamepad/pad.test.ts`** pins the other half: nothing is emitted while input is suspended, and a button or a direction held across the boundary produces nothing at all until it is released. It is also the only test of the input loop there will ever be — the suite has no DOM, which is why the fold is a pure reducer in the first place.
- **`src/shared/update.test.ts`** pins the host and repository of the two release URLs, and **`release.test.ts`** pins that an asset digest must be 64 hex characters or be treated as absent. Between them they are what keeps "the launcher replaces its own binary" pointed at this project's releases and refuses to install anything it could not verify. `version.test.ts` sits beside them because the ordering rule that matters — a pre-release is *older* than the release it precedes — is the one a three-number compare gets wrong.

## What to check by hand

The suite cannot reach the parts that matter most. Before a release, on real hardware:

- **On a second desktop, at least once.** Every compositor-dependent behaviour in this product — coming back after a game, the keyboard's placement, fullscreen on restore, focus at autostart, the portal cursor, the notice overlay — is verified on Plasma and inferred everywhere else, and that is the largest gap in this list. A GNOME live image in a VM reaches all of it except the pad. What to look at is marked below; the short version is the keyboard's layout and bottom edge, whether the notice appears over what is in front, and whether the launcher comes back to the front. Where it does not, write down what happened rather than working around it: the README's desktop table says plainly what was measured and what was read off a protocol, and moving one row from the second column to the first is worth more than a fix.

  **An X11 session is the cheapest second desktop there is, and it is the one that covers most of the others.** The notice overlay has two implementations chosen by protocol, and the X11 one — a placed `_NET_WM_WINDOW_TYPE_NOTIFICATION` window — is what Xfce, MATE, LXQt, Cinnamon and GNOME-on-Xorg all take. Logging into Plasma X11 exercises the code every one of them runs.

- A pad moves focus and the footer legend matches the pad in your hands (unplug it — the legend should switch to keycaps).
- **The whole of it again on a pad Chromium has no table for.** Most of this list is written for a pad the browser already maps; the interesting half of the input code is the other case, and the only way to reach it is with the hardware. Go through the grid, the sign-in cursor and both on-screen keyboards on at least a DualSense, a Switch-style pad and one no-name USB pad, over **both** USB and Bluetooth where the pad has both — the same controller is a different device to the kernel on each. What to look at:

  - Both the d-pad **and** the left stick move focus; the bottom face button confirms; ☰ / Options / + plays; the shoulders page the genre strip. A d-pad that does nothing is the signature of an unmapped pad being read as though it were mapped.
  - Settings → Controllers and Bluetooth lists it, with the right transport, and unplugging it takes the row away. A row reading **button layout guessed** is the launcher saying it could not place that pad, and it is the first thing to report.
  - `grep -nE 'Pad |no standard mapping' logs/gfn-launcher.log`. One line per pad the desktop backend opened, and for an unmapped one a line naming the node its numbering came from. `reports N buttons … where jsX declares M` means the premise check refused, which is the line worth an issue: it says Chromium stopped handing over the kernel's own indices.
  - A **flight stick or a wheel plugged in beside the pad** does nothing at all in the launcher — no confirm on its trigger, no drifting cursor from its throttle — and does not cancel out the pad being used.
- A game actually launches, and launches a *second* time in the same session (the second one exercises the kill-and-respawn path, the stream log's rotation, and `disarmHandback` all at once — and specifically, the launcher must *not* pop up during the two-second kill settle).
- **Power → Back to desktop, then click the launcher in the taskbar: it comes back fullscreen.** That path never reaches the main process, so it is `holdFullscreen`'s `restore`/`show` listener doing it and nothing else — and it is per-compositor, which is why no test can stand in for this one. Then flick "Open fullscreen" off and on in Settings and watch the window follow immediately; with no keyboard in the room that row is the only way back to fullscreen.
- **An update notice, on the install form you are actually shipping — all the way through the restart.** The Flatpak path needs a remote to update from; installed from the `.flatpak` bundle by hand there is none, and the correct outcome is the notice saying so rather than claiming success. Check `flatpak info --show-commit io.github.robertotucci.GfnLauncher` moved. On the AppImage, watch the byte counter climb, then confirm the file at `$APPIMAGE` is the new size and still executable.

  Then let the countdown run out rather than pressing "Restart now", and watch the launcher come back **on the new version, fullscreen, with the pad working**. This is the check that cannot be automated and the one most worth doing: a Flatpak restarts by handing a shell to the host through the portal, and everything about that — whether the child survives our exit, whether the wait loop sees the instance leave `flatpak ps`, whether the new instance gets the single-instance lock — is a property of the machine rather than of the code. If it goes wrong the symptom is a television with no launcher on it, so also try it once with `--talk-name=org.freedesktop.Flatpak` revoked in Flatseal: the launcher must stay up and say why instead of closing itself.
- The launcher stays put when a game starts — never iconified — and comes back **fullscreen and focused, with the pad working**, within a few seconds of you quitting the game. Watch the client go with `watch -n1 flatpak ps --columns=application`. On **Wayland** this is the check that matters: everything a main process can do to raise a window there is a request the compositor may decline.
- **While a game is streaming, the pad drives the game and nothing else.** Once the stream is up, deliberately push the stick around and mash A, B and ☰ for ten seconds. Quit. The launcher must come back on the *same view with the same tile focused* — no details panel, no search overlay, no second game started. Then repeat it **still holding the button you quit with**: nothing may fire until you let go and press it again, and a stick still held must not drift until you recentre it. The suite cannot reach any of this; it needs a real compositor with a real second fullscreen window in front of us.

  Then read the log: `grep -nE 'Pad input|focus|Screen ownership' logs/gfn-launcher.log`. There should be a `lost focus` from `main`, a `Pad input suspended` from `gui`, and on the way back `Pad input resumed after Ns; the pad reported input on N frames while it was suspended.` **That frame count is the evidence and it belongs in any bug report about stray input** — a large number is Chromium feeding a blurred window, which is what the gate exists for; a zero on a session you know you mashed the pad through means something else changed.
- **Blur the launcher without a game.** Settings → Open GeForce NOW, and Power → Back to desktop followed by a click in the taskbar. The pad does nothing while the launcher is not in front, works the moment it is, and no press carries across the boundary. Same for sign-in: the pad must not walk the grid while you are typing a password into NVIDIA's page.
- **The launcher still answers the pad when it is simply unfocused.** Deliberately deny it focus with nothing else running — easiest is to remove `StartupNotify=true` from `~/.config/autostart/gfn-launcher.desktop` and log back in. The window comes up at the front without focus, and the pad must still work. This is the row of the input table that keeps a compositor's refusal from becoming a dead television, and it is the one a "just gate on focus" simplification would delete.
- **Sign in with nothing but the pad, start to finish.** Settings → Sign in, then hold L3 + R3 in NVIDIA's window: a cursor appears, A clicks the address field, LB + RB opens the keyboard, and the whole login goes through without touching a mouse. This is the check that defines the feature — it is the one screen the launcher could not drive at all. While you are there, confirm the cursor **survives the navigations**: the page changes two or three times during a login and the cursor must still be there afterwards. Then open the window's console and confirm `window.launcher` and `require` are both `undefined` — the preload that draws that cursor must give the page nothing.
- **LB + RB with the desktop cursor up, over something you can type into.** A keyboard appears **flush with the bottom of the screen**, in your session's own layout — switch the system layout and reopen it to see it follow — and every character on it must actually type, the accented letters included. Write a word, press SEND, and it must land in the field behind — including a text box inside a *streamed game*, which is the case the whole feature exists for. Then do it again and cancel with ☰: nothing may be typed. Leave pointer mode with the keyboard still up and confirm the window goes with it.

  Four things to look at while it is up, because none of them has a test:

  - **The last row is whole, and above the panel rather than behind it.** Move the KDE panel to the top and try again, turn auto-hide on and try again, then open it over a fullscreen game where there is no panel at all — that one must go right to the screen edge. The log line names what was asked for against what the compositor gave: `grep 'Keyboard opened for composing' logs/gfn-launcher.log`. A `safe bottom` that does not match the panel you can see is the diagnostic.

    **And once on a desktop that reserves no bottom strut**, which GNOME is: `composeSafeBottom` is `max(0, actualHeight − workArea.height)` and has only ever been exercised where that subtraction is non-zero. The correct outcome is zero and a keyboard flush with the screen edge; a gap at the bottom means the work area is being read as smaller than the output on a compositor that reserves nothing.
  - **Every badge printed on a keycap does what it says**, on each pad, in that pad's own vocabulary: the two type-a-space and send keys are X and Y on an Xbox pad, □ and △ on a PlayStation one, Y and X on a Switch one, and the badge has to agree with the pad in your hands. Delete is B / ○ / A and discard is ☰ / ☰ / +. Where those buttons land in the kernel's numbering is a property of the pad, not of the layout — evdev codes 0x133 and 0x134 are what an Xbox calls X and Y, whatever `input-event-codes.h`'s compass aliases suggest — and the line each pad writes when it attaches is how to check. **A badge naming the wrong family is a detection fault, not a mapping one**: the buttons still do the right thing.
  - **Settings → Appearance → Keyboard size, every step.** At the largest, with **Italian, German, French or Spanish** — all four draw a row more than US and UK, because they hide printable ASCII behind AltGr and the missing characters are put back as a generated row — the panel must still be inside the screen. At the smallest the legends must still be readable from the sofa.
  - **The selected key is the accent from Settings.** Change it with the keyboard already on screen in the sign-in window: it must follow without a navigation. Try White, which is the worst case for the dark legend drawn on top of it.

  The two halves fail differently and both are worth seeing once. With no virtual keyboard selected on KDE, the launcher composes and the log says why in one line; with `plasma-keyboard` installed, selected and given a login, KWin is asked first and — unless the machine has a touchscreen — answers `willShowOnActive: false`, which must also end in the composer rather than in a claim that a keyboard was shown. Finally revoke `--talk-name=org.kde.KWin` in Flatseal: same outcome, different sentence, with the `flatpak override` that restores it.

  **On any desktop that is not KDE, the same chord must reach the composer without a bus call and without a KDE word in it.** `grep 'composing instead' logs/gfn-launcher.log` should name that desktop — GNOME, Xfce, whatever it is — and must never say `plasma-keyboard`, which for one release it said to everybody. Check the second line of the log first: `resolved=` is what the sentence was chosen from, and a wrong id there is a detection fault rather than a keyboard one. Without a second machine, `XDG_CURRENT_DESKTOP=GNOME npm run dev` reaches the same branch.
- **The keyboard is in the session's own layout, on a desktop that is not KDE.** This is the check the layout chain exists for and the one nothing in the suite can stand in for: `readSystemLayout` used to answer `null` everywhere but Plasma, and the composed keyboard silently fell back to the session *language*. Set a layout your language does not imply — an English desktop with a German keyboard is the clearest — and confirm the board that opens is the one on your desk. `grep 'Keyboard layout:' logs/gfn-launcher.log` names the layout **and which of the four sources answered**; on GNOME that should be `GNOME input sources` once `XKB_DEFAULT_LAYOUT` is out of the environment, and on Xfce or a bare compositor it should be `localed`. A line reading `from nowhere` means all four were silent and the locale is being guessed from, which is the old behaviour.

  Then revoke `--system-talk-name=org.freedesktop.locale1` in Flatseal: the keyboard must still open, in whatever the locale implies, with the log saying so.
- **Hold L3 + R3 in the first minute after a start, with no sign-in window on screen.** A headless session top-up is running then — a sign-in window built by the same function, never shown — and it must not answer the chord. What should happen is the desktop cursor with the setting on, or nothing at all with it off; what must never appear in the log is `Pointer mode on in the sign-in window` while no such window is on screen. That line meant the cursor and the keyboard were being drawn into a page nobody could see, and it looked from the sofa exactly like LB + RB being broken.
- **The pointer notice, on all three of its surfaces.** Hold L3 + R3 on the grid: a card slides in from the right at the top right, holds about three and a half seconds and slides out. Hold it twice quickly — **one** card, replaced, never two stacked or two overlapping. Then change the interface scale in Settings and do it again; the card has to grow with everything else.

  Then the two that need the overlay window, which is a different piece of code: **Power → Back to desktop** and hold the chord (the card must appear over the desktop, and a real mouse clicked on it must reach the window underneath), and **Settings → Sign in** and hold it in NVIDIA's page (the card appears, and the in-window cursor and LB + RB keyboard go on working underneath it).

  `grep -n 'Notice overlay' logs/gfn-launcher.log` writes one line the first time that window opens, naming the protocol, the route and the box it was given. On Wayland the expected shape is `[wayland, fullscreen]` at the size of the whole output; on X11 it is `[x11, placed]` at the top right **of the work area**, so move the panel to the top and to the right and check the card clears it.
- **The device notices, which need real hardware and are the half no test reaches.** Switch a controller on: **one** card, "Controller connected", naming it — not three, which is what the several nodes one pad creates would give without the settle. Switch it off: "Controller disconnected", still named. Do it over **both** USB and Bluetooth, because they are the same code path here and that is the claim. Then a **Bluetooth headset**: "Headphones connected" with its name, and the same on disconnect.

  Two things to watch for specifically. A Bluetooth *controller* must produce **one** card and not two — BlueZ skips controllers precisely because `inputWatch` already has them, and a second card means that filter is not working. And **starting the launcher with everything already on must announce nothing at all**: both watchers seed from what is there, and a row of cards at every boot is how somebody learns to ignore the corner of the screen.

  `grep -nE 'Input device (attached|removed)|Bluetooth: .* (connected|disconnected)' logs/gfn-launcher.log` is the pair of lines behind each card.
- **A machine with no radio, and one with `bluetoothd` stopped.** The BlueZ connection opens at startup now rather than at the first visit to the Devices screen, so a failure that used to happen only when somebody went there now happens at every launch on those machines. The correct outcome is **one** warning line and nothing else — no retry loop, no delay to the window, and the Devices screen still saying the daemon is not running when you open it. Same with `--system-talk-name=org.bluez` revoked in Flatseal.
- **What the overlay costs, which is a focus blip and must stay one.** On KDE Wayland the notice window takes the focus for its lifetime and hands it straight back — measured, accepted, and written down in ARCHITECTURE.md. `grep -nE 'Notice overlay|Launcher (gained|lost) focus' logs/gfn-launcher.log` should show a loss when the card appears and a matching gain about 3.6 s later, and **nothing at all** while the launcher is drawing its own notices with itself in front. A launcher that does not get the focus back, or a stream that pauses, is a different fault and is worth an issue rather than a workaround.
- **Pointer mode inside a running game**, with *Cursor outside the launcher* switched on. Start a game that shows a licence prompt or a launcher of its own, hold L3 + R3, and click the button with A. Then switch it off and confirm the game answers the pad normally again. Expect the pad to reach the game as well while the cursor is up — that is documented behaviour, not a fault; what would be a fault is the game losing the controller.
- **The cursor cannot reach the launcher behind a game.** Still streaming, with the cursor up, walk it off the edge of the GeForce NOW window onto the launcher underneath and click where a tile and the Play button are. Nothing may happen, and `grep -n 'gfn:launch\|Launching' logs/gfn-launcher.log` must show nothing new — a click landing there would kill the stream. Do the same with a real mouse: that half is a hole that predates pointer mode. Then, with the on-screen keyboard open in one of our own windows, type `/`, Enter and Escape and confirm no search overlay opens behind.
- **Pair a real device, and then check that the *system* owns the result.** Settings → Bluetooth devices, Scan, put a pad or a headset into pairing mode, A on its row. Then on the host: `bluetoothctl devices Paired` lists it and your desktop's own Bluetooth panel agrees. That is the entire claim of the feature — the launcher implements no pairing, it drives BlueZ — and nothing in the suite can stand in for it. While you are there, disconnect and reconnect with A, and forget with X.

  Then **start a scan and leave the screen**: `bluetoothctl show | grep Discovering` must go back to whatever it was before. If your desktop's panel was scanning it stays `yes`, and that is correct — BlueZ reference-counts discovery per client and leaving only releases ours. Finally, stop `bluetooth.service` and open the screen: it must say the daemon is not running, not that there is no adapter.
- **Pair from inside the Flatpak, then revoke the permission.** `--system-talk-name=org.bluez` exists for the half that cannot be tested unpackaged: bluetoothd calls *back into the sandbox* on the pairing agent, and only a `talk` grant permits that direction. Pair something from the packaged build, then:

  ```bash
  flatpak override --user --system-no-talk-name=org.bluez io.github.robertotucci.GfnLauncher
  ```

  The screen must name the permission and print the `flatpak override` that undoes it, the way a blocked host command does — not sit on an empty list. Restore it with `--system-talk-name=org.bluez`.
- Quitting the GeForce NOW client from its own UI, without ever streaming, still brings the launcher back — that is the half of the watch that does not depend on the client's log format.
- With `--filesystem=~/.var/app/com.nvidia.geforcenow` revoked in Flatseal: games still launch, one warning names the path and the errno, nothing closes the client for you, and quitting it by hand still restores the launcher.
- The screen stays on through a long browse with the pad, and goes off a few minutes after you stop. Both halves matter: the second is what stops the launcher from being a program that quietly disables your blanker.
- The Status screen names your datacenter — and **keeps up while you sit on it**. Leave the view open, change the server location in the GeForce NOW app (or switch between Auto and a pinned region), come back: the nameplate follows within a couple of seconds, without leaving the view and re-entering it.
- **Update the GeForce NOW client with the launcher open**: `flatpak update com.nvidia.geforcenow` on the host. Within ten seconds Settings names the new version, and at no point does it say the client is missing — that flicker is what the deploy-pointer rule exists to prevent, and it is the one regression here worth catching by eye. The log should carry exactly one `GeForce NOW client:` line for the change, not a stream of them. Then launch a game (it must still start) and press "Refresh every store library" (no `Could not read GFN appConfig` in the log) — between them they prove the remembered install path did not stick to the commit directory the update pruned. Uninstalling and reinstalling the client while the launcher runs must move Settings both ways, again without a restart.
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
