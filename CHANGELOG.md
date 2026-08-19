# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Release notes on GitHub and the AppStream `<releases>` block are both generated from this file.

## [Unreleased]

## [0.1.3] - 2026-08-19

### Added

- **Bluetooth devices can be paired from the launcher, without leaving it for the desktop.** Settings → Bluetooth devices opens a screen with what you have already paired and what is in the room: scan, press A on a row to pair it, again to connect or disconnect, X to forget. The pairing itself is the system's — the launcher drives BlueZ the same way your desktop's own panel does, so what you pair here works everywhere and survives a restart. What is nearby is ordered by signal strength, so the pad in your hand is at the top, and rows carry a battery figure for the devices that report one.

### Changed

- **The on-screen keyboard is on LB + RB now, not on X.** With a cursor on screen the face buttons read as mouse buttons — A clicks, B right-clicks — and a third one that opened a keyboard instead was a button nobody found. The shoulder pair sits next to the two stick clicks that raise the cursor in the first place, and it both shows and hides. Inside pointer mode the shoulders are free; outside it they still page through genres.

### Fixed

- **A failed update no longer bursts out of its own dialog.** When the notice had to report a refusal it named the command that was run, and that one long line stretched the panel's layout wider than the panel itself — the buttons, the release notes and the message all spilled out past the painted edge and over the library behind it. The command wraps onto a second line now instead of being cut off, so it is both readable and unable to move anything else.

## [0.1.2] - 2026-08-19

### Added

- **The pad can be a mouse and a keyboard.** Hold **L3 + R3** and a cursor appears: the left stick moves it, the right stick scrolls, **A** clicks, **B** right-clicks, **X** opens an on-screen keyboard with every character on it, and **☰** puts it away. This closes the gap the launcher has admitted to since the first release — NVIDIA's sign-in page is not gamepad-navigable, so linking an account from a sofa was not possible without finding a keyboard. It now is, with nothing to switch on and no permission to grant.
- **Optionally, that cursor works outside the launcher too** — on the desktop, and inside a running game, where a Steam licence prompt or an updater that wants a click otherwise leaves a session stuck. Off by default under **Settings → Pointer**, because the first use asks your desktop for permission in a dialog of its own; after that it is remembered. While it is up in a game the pad still reaches the game as well, which is why the chord is a deliberate half-second hold rather than a click.

### Fixed

- **A gamepad switched on before the launcher starts is recognised straight away.** Turning the pad on while the machine booted left it dead in the launcher until it was switched off and on again. The Flatpak could open the pad's device node but could not read the system database that says the node *is* a pad, so only a pad connected after the launcher was already running was ever seen. It now asks for that database — and if the permission is taken away, the log says so and gives the one command that restores it, instead of leaving a launcher that ignores the controller for no visible reason.
- **A stray mouse click can no longer reach the launcher hiding behind a game.** Input from the pad has been blocked in that situation since 0.1.1, but a pointer never was — a click landing on the grid behind a stream could open a panel, or press Play and close the game that was running.

### Changed

- **The keyboard shortcuts stop working while something else has the screen**, matching what the pad already did. Previously they were left alone on the grounds that an unfocused window receives no keystrokes at all — which stopped being true now that the launcher has an on-screen keyboard of its own.

## [0.1.1] - 2026-08-19

### Fixed

- **The pad no longer drives the launcher while a game is streaming.** With a game running, every stick push and button press was also reaching the launcher sitting behind it — the cursor moved, panels opened, and because ☰ is Play, a pause menu could restart the very client that was streaming. The launcher now stops acting on input whenever something else has the screen: a game, the GeForce NOW client opened from Settings, the web player, or the sign-in window. It starts answering again the moment that window goes away, and a button still held as it comes back does not count as a fresh press.
- **The launcher notices when GeForce NOW changes underneath it.** The version it reported, the datacenter it named on the Status screen and the settings it reads out of the installed client were all looked up once at start and never again — so a client that updated in the background, or a server location changed in the GeForce NOW app, left the launcher describing something that was no longer true until it was restarted. It now follows all of it while it runs, including a client installed or removed mid-session.
- **"Refresh every store library" works instead of answering "sync refused (401)".** The request was going out without the credential the service actually wants, on the assumption that being signed in was enough — it is for the catalogue, and it is not for this. The launcher now sends the right one, notices when it has gone stale, and quietly renews it and tries once more if the service turns it down anyway. When a store still refuses, the row says which ones and why, rather than reporting only the first.
- **A second press of ☰ during a hand-off no longer kills the game that is starting.** Launching begins by closing any running GeForce NOW client, so an impatient second press ended the session the first one had just opened.
- **A refresh no longer asks stores that do not do library sync.** Connecting a store and syncing a library are two different things — Epic offers the first and not the second — and asking anyway was an error on every refresh, hidden because the other stores succeeded. Those stores are now left out of the refresh and their badge reads "no sync" rather than a "0 synced" that was never going to change.
- **After a GeForce NOW update, "Refresh every store library" no longer talks to the wrong service.** An update moves the client's files, and the launcher was still reading its configuration from where they used to be — falling back to a built-in default address and remembering that default for the rest of the session, which quietly broke syncing for anyone whose client points somewhere else.
- **The screen stops being held awake as soon as another window takes the focus**, instead of up to half a minute later.
- **The cursor no longer moves inside a panel that is closing.** Buttons were already ignored during those few frames; directions were not.

## [0.1.0] - 2026-08-17

First public release.

### Added

- **Gamepad-only 10-foot interface.** One `requestAnimationFrame` loop turns pad hardware into intents; a spatial focus model moves the cursor by geometry rather than DOM order, so pressing down lands in the same column. Xbox, PlayStation and 8BitDo pads are all recognised, and the footer legend redraws itself to match the controller in your hands — or switches to keycaps when you unplug it.
- **Full GeForce NOW catalogue**, around 5 900 titles, with genre filtering, an RTX filter, and server-side search driven from an on-screen alphabetical keyboard.
- **Library and ownership.** Sign in through NVIDIA's own login page in a window the launcher owns; your linked stores' libraries appear automatically. Store chips in the details panel pick which edition launches, for the ~850 titles that exist on more than one store.
- **Details panel** with description, screenshots, supported controls, subscription tier and a QR code for the store page — because a link is useless on a TV with no browser, and a code moves it to the phone in the room.
- **The launcher closes GeForce NOW when you quit a game, and comes back to the front.** The client does not exit on its own when a stream ends — it returns to its own mall and keeps the screen, which on a machine with no mouse would leave the launcher unreachable. It is watched for the end of a session, closed, and the launcher is raised and refocused. If that watch cannot run, games still launch and quitting the client by hand still brings the launcher back.
- **Recent**, a chronology of what you played.
- **Status screen** that opens with *your* datacenter rather than a list of 76, read from the client's own routing configuration on disk. No account, no network needed for that half.
- **Settings**: accent colour (seven presets), interface scale (75–175%), fullscreen, autostart, launch mode, library sync, and a row that hands the screen to the real GeForce NOW client for the things this launcher does not mirror.
- **Support screen.** A sixth entry on the nav rail carrying a thank-you and a QR code for the PayPal donation page, large enough to scan from a sofa. The link was already in the README and in the software-centre metadata, neither of which the person actually using the launcher ever sees. Pressing confirm opens the page in a browser on machines that have one; the code is the path that always works, and it needs no network to draw.
- **Power menu** — back to desktop, sleep, restart, turn off — because the launcher is the last thing on screen before the TV goes off.
- **Autostart** via a standard XDG desktop entry, so the launcher comes up with the session.
- **A screen that stays on while you are using the pad.** A joystick is not an input device as far as a desktop's idle timer is concerned, so a launcher driven from a controller would otherwise be read from a television on its way to going dark. The display is held awake for five minutes after each press and let go as soon as the window loses focus, so an empty room still gets its screen off and the GeForce NOW client is left to manage its own.
- **Offline behaviour.** Fonts are self-hosted, the catalogue is cached on disk, and a machine that has never fetched anything still shows a usable interface.
- **The launcher tells you when there is a new version, installs it, and restarts into it.** A notice carries the release notes and, where this build is allowed to replace itself, a button that does it: a Flatpak runs `flatpak update`, an AppImage downloads the new file and checks it against the checksum GitHub published. A progress bar follows either one — the percentage flatpak reports, or the megabytes as they arrive — and when it finishes the launcher reopens itself on the new version after a ten-second countdown you can stop. A copy installed by a package manager gets a QR code for the release page instead, because that install belongs to the package manager. Nothing downloads without you saying so, nothing is installed unverified, and "Not now" means not again until the next release. The check itself can be turned off in Settings.
- **There is a log file to attach to a bug report.** The launcher writes down what it started, what it asked the machine for and what the machine said — every launch and the exact command, whether it got the screen back afterwards, host calls that failed, updates either side of installing them. Credentials are stripped from every line before it is written, so the file is safe to paste into a public issue. Settings names the path, and so does the README.
- **A crash says so instead of showing a black screen.** If the interface fails while drawing, the launcher replaces it with a page naming the fault and the log file, and any button on the pad reloads it. A renderer that dies outright is brought back automatically, up to three times.

### Packaging

- Flatpak, the recommended install on any distribution.
- AppImage and `.deb` for anyone who would rather not use Flatpak.
- x86_64 only, matching the GeForce NOW client.

[0.1.3]: https://github.com/robertotucci/gfnlauncher/releases/tag/v0.1.3
[0.1.2]: https://github.com/robertotucci/gfnlauncher/releases/tag/v0.1.2
[0.1.1]: https://github.com/robertotucci/gfnlauncher/releases/tag/v0.1.1
[0.1.0]: https://github.com/robertotucci/gfnlauncher/releases/tag/v0.1.0
