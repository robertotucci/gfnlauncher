# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Release notes on GitHub and the AppStream `<releases>` block are both generated from this file.

## [0.1.5] - 2026-08-22

### Added

- **Games now open fullscreen, with no window frame around them.** GeForce NOW only took the whole screen once a game was actually streaming — its menus, the pre-launch dialog and the loading screen came up in a window with a title bar across the top and the launcher showing around it, which is the one moment the desktop broke through. The launcher now asks the desktop to make that window fullscreen and borderless from the instant it appears, so the whole sequence from pressing Play to the game itself has nothing on screen but GeForce NOW. On KDE it does this through KWin and needs nothing installed; on other desktops it uses `xdotool` if it is there. Either way, if it cannot be done the game still launches exactly as before, with the frame it always had. There is a switch for it in Settings → GeForce NOW client, on by default.

### Fixed

- **Games sold on more than one store no longer stop to ask which one you bought them from.** Press Play on Battlefield 6 or Dishonored: Death of the Outsider and GeForce NOW put up "Prima di giocare" with a list of stores, every time — even for a game you own, on an account that had already answered that question, and even after picking a store here in the launcher. The launcher was naming the right edition all along; the client was throwing that away and going to look one up for itself, and the query it uses on that path cannot see which store you chose, so the answer was always "I don't know, ask him". It only did this when the deep link left out one optional field, which the catalog leaves blank for about a third of its entries — hence some titles and not others. That field is now always sent, and the client streams the edition it was given: the one your account owns, or the one you pinned in the game's details panel. 234 titles were affected, 30 of them in a typical owned library.

## [0.1.4] - 2026-08-21

### Added

- **The launcher now works properly on GNOME and every other desktop, not only on KDE.** It was written and measured on KDE Plasma, and three things quietly assumed it. The on-screen keyboard it draws for you now types in **your keyboard's layout on any desktop** — it asks your session four ways, where before it only knew how to ask KDE and everywhere else fell back to guessing from your language, so an English desktop with a German keyboard got an American one. It no longer tells you to install a KDE package when you are not on KDE: it says which keyboard you are about to see, in your own desktop's name, and gets on with drawing it. And the menu entry the `.deb` and the AppImage install now asks the session for permission to come to the front, which it never did — without it a launcher started at login could come up behind everything, unable to keep the screen awake, on a machine with no keyboard.
- **Four more keyboards: German, French, Spanish and UK**, beside the American and Italian ones already there. Each is the real thing — QWERTZ, AZERTY, `"` and `@` where a UK keyboard puts them — and every character that a national layout hides behind AltGr is still one press away on the extra row.
- **The launcher now says when the pad's mouse goes on and off.** Holding L3 + R3 raises a cursor, and until now the only sign that it had worked was the cursor itself — which tells you nothing at all when there was no cursor, because the setting was off or your desktop refused the permission. A card now slides in at the top right naming what happened and the hold that undoes it, and gets out of the way after a few seconds. It is **visible while a game is streaming**, which is the case the cursor exists for and the one place the launcher could not previously show you anything: its own window is behind the stream, and so was everything it drew. On a desktop that cannot put a window over a fullscreen game the card is simply not shown; nothing else changes.
- **And when a device connects or disconnects.** Switch a controller on and the launcher says so by name, over USB or Bluetooth; the same for a headset, a keyboard or anything else that arrives over Bluetooth. It is one card per device rather than one per kernel node, it says nothing at all for the hardware that was already on when the launcher started, and — like the notice above — it is visible over a running game, which is where "did that pad actually connect?" is hardest to answer.
- **The Power menu works on distributions without systemd.** Suspend, restart and turn off fall back to `loginctl`, which elogind provides, when `systemctl` is not on the machine. A refusal is still shown to you unchanged; only a missing command is retried.
- **Switch-style controllers are named correctly.** B confirms and A goes back, the way they do everywhere else on Linux, and the footer, the cursor hint and both on-screen keyboards now say so instead of saying A and B. The buttons themselves do not move: the one under your thumb still confirms, whichever controller you pick up.
- **The on-screen keyboards name your own pad's buttons.** A PlayStation pad was told to press X for a space and Y to send, and it has neither; it now says □ and △, and the hint under the cursor says × and ○ rather than A and B.
- **Settings → Controllers and Bluetooth lists the controllers that are connected**, with how each one is attached and whether the launcher had to guess at its buttons — the one fact that explains a pad behaving oddly, and until now it was only in the log file.

### Fixed

- **Controllers that Linux has no translation table for now work properly.** Generic USB pads, several third-party PlayStation-shaped pads and some pads over some connections are handed to the launcher with their buttons in the order the *controller* declares them rather than in a standard order, and the launcher read them as if they were an Xbox pad. The d-pad did nothing, the wrong face buttons fired, the right stick scrolled on a trigger, and **☰ — the button that starts a game — was a stick click**. It now asks the system what each button on each pad actually is, which is the same question it already asked for the desktop cursor, and uses the answer everywhere: the grid, the cursor in the sign-in window, and both on-screen keyboards. A pad it still cannot place behaves exactly as it did before rather than worse, and the log says which one and why.
- **A flight stick or a wheel plugged in beside the pad no longer presses buttons in the launcher.** Its trigger is the same number as a gamepad's A, so pulling it opened whatever the cursor was on, and a throttle resting off centre scrolled the page on its own. The launcher now recognises that such a device is not a controller and reads nothing from it.

## [0.1.3] - 2026-08-20

### Added

- **LB + RB now types outside the launcher too — on the desktop, and inside a running game.** The keyboard the launcher draws lives inside its own two windows and cannot follow the cursor out: anything drawn over somebody else's window takes the focus away from the very thing you are trying to type into, and then the letters go nowhere. So out there the chord opens a keyboard, you write the whole line with the pad, and the moment you press SEND it gets out of the way and types what you wrote into whatever was in front — as real keystrokes, which is why it reaches a login box inside a streamed game and not just a window on your own desktop.

  **The buttons are printed on the keys.** **A** presses whatever the selection is on; **X** is space, **Y** sends, **B** deletes, and **☰** throws the line away — and each of those four is written on the key it belongs to, so there is nothing to remember. Both of the launcher's keyboards now say the same thing, which is why **B** deletes on the sign-in one as well instead of hiding it; LB + RB still puts that one away, and ☰ still leaves the cursor entirely.

  If your desktop has an on-screen keyboard of its own it is offered that first, since a keyboard the compositor draws can float over a game without disturbing it. On KDE that needs `plasma-keyboard` installed, chosen under Settings → Keyboard → Virtual Keyboard, and one login after choosing it — and even then KDE only raises it for touchscreens, so on an ordinary machine the launcher notices that answer and writes the line itself instead.

  It is **your** keyboard: QWERTY, in the layout your session is set to, accented letters and all — asked of the desktop, with the language as a fallback. The characters a national layout hides behind AltGr are put back on a row of their own, so an address with an `@` in it can still be typed on an Italian keyboard. It is laid out like a keyboard rather than a grid of tiles — the rows are staggered, the spacebar is a spacebar — and it sits along the bottom of the screen where an on-screen keyboard belongs, drawn with [simple-keyboard](https://github.com/hodgef/simple-keyboard), which ships inside the launcher: there is nothing to install for this, on any desktop. Its keys are also clickable with the pad's cursor, if that is closer to hand than walking to them.

- **Keyboard size, in Settings → Appearance.** Five steps, from 80% to 130%, for both of the keyboards the pad opens. It is separate from Interface size because it is a different question: this one is drawn over the window you are typing into, so a bigger keyboard is easier to hit and covers more of the thing you are filling in. It does not change the keyboard in the launcher's own search.

- **The selected key is your accent colour.** Both on-screen keyboards used a fixed pale blue and ignored the accent row entirely. They now wear whatever you picked, and follow it the moment you change it — even with a keyboard already on screen.

- **Bluetooth devices can be paired from the launcher, without leaving it for the desktop.** Settings → Bluetooth devices opens a screen with what you have already paired and what is in the room: scan, press A on a row to pair it, again to connect or disconnect, X to forget. The pairing itself is the system's — the launcher drives BlueZ the same way your desktop's own panel does, so what you pair here works everywhere and survives a restart. What is nearby is ordered by signal strength, so the pad in your hand is at the top, and rows carry a battery figure for the devices that report one.

### Changed

- **The on-screen keyboard is on LB + RB now, not on X.** With a cursor on screen the face buttons read as mouse buttons — A clicks, B right-clicks — and a third one that opened a keyboard instead was a button nobody found. The shoulder pair sits next to the two stick clicks that raise the cursor in the first place, and it both shows and hides. Inside pointer mode the shoulders are free; outside it they still page through genres.

### Fixed

- **The bottom row of the on-screen keyboard is no longer cut off by the taskbar.** The keyboard asked for a window the size of the usable screen and left it to the compositor to place, and on Wayland a client is not allowed to place itself: KDE put it low enough that the last row of keys sat behind the panel. It now takes the whole screen and works out for itself how much of its own bottom edge it cannot use, which comes out right whether the panel is over it or the window was pushed past the edge — and the log records what it asked for against what it was given, so the next machine that disagrees can be diagnosed from the file.
- **L3 + R3 raises the cursor outside the launcher with a pad connected over Bluetooth.** It did nothing at all — no cursor on the desktop, none inside a running game — with an Xbox controller paired over Bluetooth, which is how most of them are used. The launcher was looking for the two stick clicks at the position they occupy when the same pad is plugged in with a cable, and Linux numbers a pad's buttons by what the pad declares about itself: over Bluetooth those two land somewhere else entirely, and a DualSense puts them somewhere else again. The launcher now asks the system what each button on each controller actually is, so the chord means the same thing on every pad and on either way of connecting one. The right stick scrolls with it, which on a Bluetooth pad had been the right trigger. Sign-in and the web player were never affected: those read the pad through the browser, which does its own translating.
- **A hold that came due on the same millisecond as a flick of the stick no longer does nothing.** The half-second on L3 + R3 was checked in two places, and only one of them could act on it, so a chord that completed in the wrong instant was quietly discarded and had to be held again. It also affected pads connected with a cable.
- **LB + RB opens the on-screen keyboard again, instead of opening it where nobody could see it.** The launcher tops your GeForce NOW session up in the background at every start, and it does that in a sign-in window it never shows you. That invisible window was reading the pad: hold L3 + R3 in the first minute and it took the cursor for itself, so the keyboard LB + RB asked for was drawn into a page that is not on screen. It also claimed to be showing a cursor, which is the signal that stops the desktop one from opening — so for that minute and a half the chord could do nothing anywhere. Only a window you can actually see reads the pad now.
- **Two cursors can no longer be up at once.** The window cursor and the desktop one are raised by the same chord and were deciding which of them should answer in a race that took a few hundred milliseconds to settle, so holding L3 + R3 with the sign-in page in front could raise both. A window of ours in front always wins, whichever got there first.
- **The log says how many controllers were found.** It reported "waiting for a pad" every time, including with one already connected, because it asked before the pad had answered. It now names each pad as it connects, along with where that pad's L3 and R3 turned out to be.
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

[0.1.5]: https://github.com/robertotucci/gfnlauncher/releases/tag/v0.1.5
[0.1.4]: https://github.com/robertotucci/gfnlauncher/releases/tag/v0.1.4
[0.1.3]: https://github.com/robertotucci/gfnlauncher/releases/tag/v0.1.3
[0.1.2]: https://github.com/robertotucci/gfnlauncher/releases/tag/v0.1.2
[0.1.1]: https://github.com/robertotucci/gfnlauncher/releases/tag/v0.1.1
[0.1.0]: https://github.com/robertotucci/gfnlauncher/releases/tag/v0.1.0
