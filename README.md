# GFN Launcher

A couch launcher for NVIDIA GeForce NOW. Fullscreen, gamepad-only, starts with your desktop session, and hands games off to the native GeForce NOW client.

Built for the television rather than the desktop: a 10-foot interface you drive from three metres away, where the cover art is the brightest thing on screen and the launcher's own chrome gets out of the way.

Linux only.

![The catalogue grid: a hero band showing the focused title above a strip of genre filters and a grid of cover art, with the focused tile carrying the only cursor on screen](docs/screenshots/grid.png)

The whole GeForce NOW catalogue — 5 889 titles the day this was taken. The ring around one cover is the cursor, and the strip above it is every genre with its count. More views in [docs/screenshots](docs/screenshots).

## Support the project

This launcher is developed on a best-effort basis, in time taken from elsewhere and at my own expense. It is free and always will be, and there is no paid tier waiting behind it.

If it earned a place on your television, a donation is the most direct encouragement to keep working on it and to keep making it better.

<p align="center">
  <a href="https://www.paypal.com/donate/?hosted_button_id=6TJMUEWLPE95Y">
    <img src="docs/donate-qr.png" alt="QR code linking to the PayPal donation page" width="200">
  </a>
</p>

<p align="center">
  <a href="https://www.paypal.com/donate/?hosted_button_id=6TJMUEWLPE95Y"><strong>Donate with PayPal</strong></a>
  <br>
  <sub>Or point a phone camera at the code above.</sub>
</p>

## Requirements

- The official **GeForce NOW Flatpak**, `com.nvidia.geforcenow`
- A gamepad — Xbox, PlayStation and 8BitDo pads all report the standard layout
- Any Linux distribution with Flatpak
- Any desktop — see [desktops it runs on](#desktops-it-runs-on). The one thing the launcher asks of yours is `systemd` or `elogind`, which the Power menu calls to suspend, restart and turn off

You do not need a GeForce NOW account to browse or to launch: the deep link goes to the local client, so **launching games works signed out**. Signing in adds your library and ownership.

## Desktops it runs on

Nothing here is written for one desktop. The launcher draws its own window, reads the pad from the kernel, writes a plain XDG autostart entry, ends the session through logind and asks for a cursor through a portal — every one of which is the same on Plasma, GNOME and everything else. Two things are not, and both are below the table: which on-screen keyboard you get, and where the keyboard layout is read from.

| Desktop | Notes |
| --- | --- |
| **KDE Plasma**, Wayland | Everything. This is where it was written and where every measurement in [ARCHITECTURE.md](./ARCHITECTURE.md) was taken |
| **GNOME**, Wayland | Everything, with the launcher drawing its own keyboard rather than borrowing GNOME's — see below |
| **Cinnamon, Budgie, Xfce, MATE, LXQt, Pantheon, Deepin** | The same. These reuse GNOME's or KDE's portal, which is what the desktop cursor goes through |
| **sway, Hyprland and other wlroots compositors** | Everything except the desktop cursor: `xdg-desktop-portal-wlr` implements screen capture and not `RemoteDesktop`. Autostart also needs something that runs XDG entries — `dex`, or your compositor's own `exec-once` |
| **Any X11 session** | Raising the launcher after a game is *more* reliable than on Wayland, not less. Whether the desktop cursor works depends on your portal backend, which on X11 varies by desktop |

The one thing in that table worth checking rather than assuming is the desktop cursor, and it tells you: if the portal is not there, the chord logs `Could not start the desktop pointer` and nothing else changes. The cursor inside the launcher's own windows — the sign-in page and the web player, which is what it is mostly for — needs no portal and works everywhere.

**The on-screen keyboard is always the launcher's own, except on KDE.** There is no cross-desktop protocol for "show the keyboard": GNOME has one and raises it for touch input with no way to ask, and the rest have none at all. So on every desktop but Plasma the launcher stops trying to borrow one and draws a full keyboard itself, which is the path that works everywhere and the only one that types into a streamed game. You lose nothing by not being on KDE here — on Plasma the launcher asks first, and Plasma declines too unless the machine has a touchscreen.

**It types in your keyboard's layout, not your language's**, and it finds that out four ways: `XKB_DEFAULT_LAYOUT`, then your desktop's own setting on Plasma and on the GNOME family, then `localectl`'s system layout, and only then the locale. Six layouts ship — US, UK, Italian, German, French, Spanish — and anything else gets US QWERTY with every printable character still reachable.

**Coming back after a game is a request on every Wayland compositor**, and neither KWin nor Mutter is obliged to grant it: a client cannot raise itself without an activation token, and no application can mint one for itself. The launcher asks in four ways, logs what it got, and goes on answering the pad either way — see [reporting a problem](#reporting-a-problem) if yours does not come back. On X11 this is simply not an issue.

Two honest notes. Everything above that says *measured* was measured on Plasma 6.7 under Wayland, because that is the machine this is developed on; the rest is read from the protocols and the portal implementations rather than from a screen. And the launcher writes the desktop it detected on the second line of its log, so a report never has to guess.

## Install

**You already have Flatpak.** GeForce NOW on Linux *is* a Flatpak, so the one prerequisite for the recommended install is the same thing this launcher requires anyway. Nothing new to adopt.

### Flatpak from this project's own remote — recommended, and updates itself

```bash
flatpak remote-add --if-not-exists --user gfnlauncher \
  https://robertotucci.github.io/gfnlauncher/gfnlauncher.flatpakrepo
flatpak install --user gfnlauncher io.github.robertotucci.GfnLauncher
```

Two commands once, and then nothing to do again: `flatpak update` carries every later release, and so does **Install the update** inside the launcher. Updates arrive as deltas — a new version costs a few megabytes rather than ninety, because everything that did not change is already on your disk.

The repository is signed, and `flatpak remote-add` reads the key out of the `.flatpakrepo` along with the address. There is no key to copy by hand and no `--no-gpg-verify` anywhere in that command: an unsigned build cannot reach you through this remote.

You need Flathub configured as well, though not for this launcher — the runtime it runs on, `org.freedesktop.Platform`, comes from there, as it does for most Flatpaks on your machine. If GeForce NOW is installed you almost certainly already have it.

This launcher is **not on Flathub** and there is no build to install from there. This remote is what stands in for it, and it is the same arrangement NVIDIA uses for the GeForce NOW client itself, which is not on Flathub either.

### Flatpak bundle — offline, and needs no remote

Works on every distribution, from a single file, with nothing configured.

```bash
flatpak install --user ./GfnLauncher-<version>.flatpak
flatpak run io.github.robertotucci.GfnLauncher
```

A bundle installed by hand has nothing to update from, so this one does not update itself: each release is a new bundle to download. The launcher still notices a new version and tells you, and is honest about not being able to install it for you — it reads the deployed commit either side of an update rather than trusting `flatpak update`, which succeeds and changes nothing when there is no remote behind it.

### AppImage — if you would rather not use Flatpak at all

```bash
chmod +x GFN-Launcher-<version>.AppImage
./GFN-Launcher-<version>.AppImage
```

### .deb — Debian and Ubuntu

```bash
sudo apt install ./gfn-launcher_<version>_amd64.deb
```

All artefacts are attached to each [release](https://github.com/robertotucci/gfnlauncher/releases). x86_64 only, because the GeForce NOW client is x86_64 only — an arm64 build would be a launcher that cannot launch anything.

## Controls

| Button | Action |
| --- | --- |
| Left stick / D-pad | Move |
| **A** | Details — opens the panel, with the cursor already on **Play** |
| **B** | Back |
| **X** | Search — or, in the details panel, mark as owned |
| **Y** | Settings |
| **☰** Menu / Options / Start | Play immediately |
| **LB** / **RB** | Step through the set in front of you — genres on the grid, screenshots in the viewer |

Two presses launch a game, both on A: A opens the details panel with **Play** already focused, A again plays it. ☰ skips the panel when you already know what you want.

When you quit the game, the launcher closes the GeForce NOW client for you and comes back to the front. The round trip is meant to be a round trip: press Play, play, quit, and you are back on the grid with the pad still working — no keyboard, no mouse, and nothing left holding the screen.

A keyboard mirrors the pad, mostly for development:

| Key | Action |
| --- | --- |
| Arrow keys | Move |
| `Enter` | A |
| `Escape` | B |
| `/` | Search |
| `Tab` | Settings |
| `F1` | ☰ (play) |
| `[` `]` | LB / RB |

`F1` and the brackets rather than letters, and `Escape` rather than `Backspace`: the search overlay types letters and deletes with Backspace, and a key cannot mean two things.

Search is driven by an on-screen alphabetical keyboard — A–Z in a grid, because on a pad you scan for a letter rather than reach for it.

The footer legend always describes the controller in your hands. Unplug the pad and it switches to keycaps; plug in a PlayStation pad and A becomes ✕.

### Pointer mode — the pad as a mouse

Some things are not a grid. **Hold L3 + R3** — both stick clicks, for about half a second — and the pad becomes a mouse. Hold them again, or press ☰, to put it away.

| Input | While the cursor is up |
| --- | --- |
| Left stick | Move the cursor |
| Right stick | Scroll |
| **A** | Left click |
| **B** | Right click |
| **LB + RB** | Show or hide the on-screen keyboard |
| **☰** | Put the cursor away |

With the keyboard open the stick picks a key and **A** types it; **LB + RB** again — or **B** — hides it. It is alphabetical like the search one, and it has every character on it, because a password with a backslash in it is not one you can leave out.

The keyboard is on the shoulders rather than on a face button because with a cursor on screen the face buttons read as mouse buttons, and a third one that does something else is a button nobody finds. Two shoulders, next to the two stick clicks that opened the mode.

**The keyboard only exists in the two places the launcher itself puts a web page in front of you**: **signing in to NVIDIA**, which is the one screen a pad genuinely cannot navigate and the reason an account could not be linked from a sofa at all, and the **web player**. Both work out of the box, with nothing to switch on. On the desktop and inside a game there is no keyboard — see the note at the end of this section.

**Outside the launcher it is off by default** — see *Cursor outside the launcher* under Settings → Pointer. Switched on, the same hold gives you a real cursor on the desktop and, more usefully, **inside a running game**: a Steam licence prompt or an updater that wants a click is otherwise a stuck session. It asks your desktop for permission the first time, in a system dialog that needs a real mouse or keyboard to answer; after that it is remembered and silent.

Two things to know before you use it in a game:

- **The pad still reaches the game.** GeForce NOW reads the controller itself and forwards it, and the launcher does not take it away — doing so would need to seize the device, and a bug in putting it back would leave you with no controller at all. So while the cursor is up the stick moves it *and* whatever the game does with a stick. In the situation this is for — a dialog on top of a game that is not listening — that costs nothing. It is why the chord is a deliberate hold rather than a click.
- **The on-screen keyboard is launcher-windows only**, so **LB + RB** does nothing out here. This is measured rather than assumed: a window created the way an overlay would have to be — `focusable: false`, always on top, shown without activating — still took the focus away from the window underneath it on KDE Wayland, and nothing in the protocol makes that a KDE quirk: an ordinary Wayland toplevel cannot float over another client's fullscreen surface without becoming the focused window. The focus is exactly what decides where a keystroke lands, so a keyboard drawn that way types into itself. The cursor works everywhere; typing works where the launcher owns the window. If you need to type into a game, [AntiMicroX](#a-full-keyboard-on-the-pad-everywhere--antimicrox) is the answer, and it is kernel-side for the same reason.

## What is in it

- **Grid** of the whole GeForce NOW catalog (~5 900 titles), with genre filtering and an RTX filter
- **Library** view of what you own, once signed in
- **Recent** — what you played, in the order you played it
- **Search**, server-side, driven from the on-screen keyboard
- **Details panel** — description, screenshots, supported controls, subscription tier, and store chips for picking which store's edition launches
- **Status** — GeForce NOW service health, opening with *your* datacenter rather than a list of 76. Read from the client's own routing configuration on this disk, so it needs no account and works offline
- **Pointer mode** — hold L3 + R3 and the pad becomes a mouse and a keyboard, for the screens that are not a grid
- **Bluetooth** — pair a pad, a headset or a keyboard without leaving the launcher. See [pairing a device](#pairing-a-device)
- **Settings** — sign-in, library sync, accent colour, interface scale (75–175%), fullscreen, autostart, launch mode, pointer mode
- **Power** — back to desktop, sleep, restart, turn off. The launcher is the last thing on screen before the TV goes off

## Pairing a device

**Settings → Bluetooth devices.** Two lists: what you have already paired, and what is in the room. Press A on Scan, put the device into pairing mode — usually a button held until its light flashes — and press A on its row. A again connects or disconnects something already paired; **X** forgets it.

What is nearby is **ordered by signal strength**, with a four-tick meter on each row, which is how you tell which of three rows called *Wireless Controller* is the one in your hand. Devices that report a battery show it.

**The pairing is your system's, not the launcher's.** It drives BlueZ over the same interface your desktop's own Bluetooth panel uses, as your own user and with nothing elevated — so a pad paired here is paired everywhere, shows up in that panel, and comes back after a reboot. Forgetting one here removes it from the computer, not just from this screen.

Two limits worth knowing:

- **A device that wants a PIN typed on the computer is refused, and says so.** Numeric confirmation works — the launcher shows the six digits and A confirms them — and so does a code you type on the *other* device. Something that wants you to type into this machine needs a keyboard this screen does not have; pair it from your desktop's Bluetooth settings.
- **Pairing a pad needs a pad.** Or a keyboard: arrow keys, Enter and Escape drive every screen. The launcher cannot help you with the very first controller, only with the second one.

## Signing in

Open **Settings** (Y) and choose **Sign in to GeForce NOW**. NVIDIA's own sign-in page opens in a window the launcher owns; log in as you normally would. The session persists, so this is a one-time step.

Two things worth knowing:

- **NVIDIA's login page is not gamepad-navigable**, so the launcher brings its own cursor: hold **L3 + R3** in that window and the pad becomes a mouse, then **LB + RB** for an on-screen keyboard to type the address and the password. See [pointer mode](#pointer-mode--the-pad-as-a-mouse). No setting to switch on, and no permission — it works there out of the box.
- The launcher reads the session off that window and keeps the bearer token in memory only. It is never written to disk.

## Sandbox permissions, and why

The Flatpak asks for more than a typical app, and it is worth saying plainly why. You can inspect the list yourself:

```bash
flatpak info --show-permissions io.github.robertotucci.GfnLauncher
```

| Permission | What needs it |
| --- | --- |
| `--talk-name=org.freedesktop.Flatpak` | Running commands on the host: `flatpak` to launch the GeForce NOW client with a deep link and to stop a running one first, `systemctl` for the power menu, and writing the autostart entry into your real `~/.config/autostart` |
| `--device=all` | Reading the gamepad, and the GPU |
| `--filesystem=/run/udev:ro` | Recognising a pad that was already switched on before the launcher started. The line above opens the device node; this is the udev database Chromium reads to know that the node *is* a gamepad. Without it, a pad is only seen if it is connected — or switched off and on again — after the launcher is running |
| `--talk-name=org.gnome.SessionManager`, `--talk-name=org.freedesktop.PowerManagement`, `--talk-name=org.freedesktop.ScreenSaver` | Asking the session not to blank the screen while you are browsing with the pad. Three names because each desktop answers on a different one — GNOME on the first, KDE and Xfce on the second, and the third is the interface the freedesktop idle specification defines — rather than the whole session bus for one call |
| `--talk-name=org.kde.KWin` | Asking KDE to raise its own on-screen keyboard, which is the only desktop that can be asked. Absent everywhere else and never called there: the launcher resolves the desktop before it opens a bus, and draws its own keyboard instead. Revoke it on KDE and you get the same keyboard, one line in the log, and the command to put it back |
| `--system-talk-name=org.freedesktop.locale1` | Reading `localectl`'s keyboard layout, so the keyboard the launcher draws matches the one on your desk. The last of four sources, and the only one that answers on Xfce, MATE, LXQt and a bare compositor. A property read — `localectl` needs polkit to *change* a layout and nothing to report one. Revoke it and the keyboard still opens, in the layout your locale implies |
| `--filesystem=~/.var/app/com.nvidia.geforcenow:ro` | Reading which datacenter your client is set to stream from, for the Status screen — and noticing when a game has finished, so the launcher can close the client and take the screen back |
| `--filesystem=…/flatpak/app/com.nvidia.geforcenow:ro` | Reading the GeForce NOW client's own service configuration instead of hardcoding NVIDIA's hostnames |
| `--system-talk-name=org.bluez` | [Pairing a device](#pairing-a-device). The only name on the system bus, and the same calls your desktop's Bluetooth panel makes as the same unprivileged user — BlueZ's own policy allows them, and there is no polkit on this path. It is `talk` rather than `see` because BlueZ calls *back* to ask whether a pairing code matches |
| `--share=network` | The catalog, sign-in, and the status page |
| `--socket=wayland`, `--socket=fallback-x11`, `--share=ipc` | Drawing a window |
| `--socket=pulseaudio` | Sound, for the web-player fallback |

**`--talk-name=org.freedesktop.Flatpak` is effectively an exit from the sandbox**, and there is no way around it for an app whose entire purpose is to drive another Flatpak. There is no portal for "launch this Flatpak with these arguments" — the deep link is an argv, not a URI scheme — and stopping a running client needs the host too. If that trade is not one you want to make, the AppImage does the same things with no sandbox at all, which is at least honest about it.

It is also the *only* permission that leaves the sandbox. The autostart entry goes through it rather than through a second `--filesystem=xdg-config/autostart:create`, precisely so there is one door to inspect rather than two. The three screen names under it, KWin, localed and BlueZ are ordinary services being asked a question; none of them can run anything.

**Nothing in that list is what gives the cursor the desktop.** [Pointer mode](#pointer-mode--the-pad-as-a-mouse) outside the launcher's own windows goes through `org.freedesktop.portal.RemoteDesktop`, which is a portal — Flatpak permits every application to talk to the portals, and a portal is the sanctioned way out precisely because *you* answer for it, once, in a dialog the launcher cannot draw or dismiss. That is also why it needed no new line above, and why the alternative was rejected: a virtual device through `/dev/uinput` would have wanted `--device=all` to mean rather more than reading a pad, plus a udev rule installed as root. Revoke it in your desktop's remote-control or screen-sharing settings and the cursor stops at the launcher's own windows, where it needs nothing.

Every permission can be revoked with [Flatseal](https://flathub.org/apps/com.github.tchx84.Flatseal) or `flatpak override`. Revoke the host one and the launcher will tell you what is missing rather than pretending GeForce NOW is not installed. Revoke the BlueZ one and the Devices screen prints the command that grants it back. Revoke the three screen ones and nothing will say so — a blocked Inhibit call still looks like it succeeded from inside the sandbox, and all you see is the screen going dark while you browse, which is what it did before it asked.

## Waking the machine with the pad

Not something the launcher can do — `/sys/bus/usb/devices/*/power/wakeup` is root-owned. It takes one udev rule, written up in [docs/wake-on-gamepad.md](./docs/wake-on-gamepad.md).

## Things worth installing around it

None of this is required, and none of it is bundled. The launcher drives whatever pad the kernel already exposes, and on a current kernel that is every pad worth naming. These are the places a television setup runs out of road, and the smallest thing that fills each.

### A full keyboard on the pad, everywhere — AntiMicroX

[Pointer mode](#pointer-mode--the-pad-as-a-mouse) now covers what this section used to exist for: the sign-in page, the web player, the desktop after **Back to desktop**, and clicking a prompt inside a running game. Two things it deliberately does not cover, and this is what fills them.

**Typing outside the launcher's own windows** — the on-screen keyboard cannot be drawn over another program's fullscreen surface on Wayland, so entering a key into a game's own launcher is still out of reach. And **playing the 1 835 catalogue titles that are keyboard-and-mouse only**, which is a different job altogether: a mapping you want held down mid-game, not a mode you toggle.

[AntiMicroX](https://github.com/AntiMicroX/antimicrox) maps sticks to a pointer and buttons to keys through `/dev/uinput`, which is kernel-side — so the launcher, the GeForce NOW client and the stream all see an ordinary mouse and keyboard, sandbox or no sandbox. That is also the thing the launcher will not do for itself: `/dev/uinput` needs a udev rule installed as root, which is not something to ask of a machine whose whole point is that it is driven from a sofa.

```bash
flatpak install flathub io.github.antimicrox.antimicrox
```

It is also `antimicrox` in Arch's `extra` and in Fedora's repositories, and on Wayland those are the better choice: the Flathub build needs upstream's `60-antimicrox-uinput.rules` dropped into `/etc/udev/rules.d/` by hand before it can reach uinput. [input-remapper](https://github.com/sezanzeb/input-remapper) does the same job as a system service if you would rather have it always on; there is no Flatpak of it, deliberately, because the daemon needs `/dev/uinput` from outside a sandbox.

Switch a profile on when you need it rather than leaving one running. Nothing grabs the pad exclusively, so while it is mapped it is still a pad as well, and on the launcher's own screens **A** would confirm twice.

### A screen that does not blank — joystickwake

A gamepad is not an input device as far as a compositor's idle timer is concerned: the sticks can be moving and the television still goes dark on schedule. The launcher handles its own screens — it holds the display awake for five minutes after each press, and lets go when it loses focus, so it cannot leave a static grid burning on a television all night. Nothing else on the machine does the same, including anything else you drive with a pad. [joystickwake](https://codeberg.org/forestix/joystickwake) watches the joystick devices for all of them and pokes the blanker when they move.

```bash
# from the AUR, with whichever helper you use
paru -S joystickwake
```

Packaged as `joystickwake` in Debian unstable and Ubuntu 26.10; everywhere else it is one Python file to copy into your `PATH`. Its stock wake commands do not take on Plasma under Wayland, where it needs the custom one documented upstream; check its own README for whichever desktop you are on before assuming it is working.

### Drivers, only where the kernel runs out

| Pad | What the kernel already does | What is left to install |
| --- | --- | --- |
| Xbox 360, One and Series over USB | `xpad`, in tree | Nothing |
| Xbox One and Series over Bluetooth | Everything you need since 6.5, rumble included | `xpadneo`, and only for trigger rumble, battery level and the Elite paddles |
| The Xbox Wireless Adapter dongle | Nothing — the protocol is proprietary, not HID | `xone`, plus the dongle firmware |
| DualSense and DualShock 4 | `hid-playstation` since 5.12: sticks, rumble, touchpad, battery, lightbar | Nothing. `dualsensectl` if you want the pad to switch off from the sofa, which the PS button does not do here |
| 8BitDo and the rest | The standard layout, in X-input mode | Nothing — but mind the mode switch. In DirectInput the button indices move and the Controls table above stops describing your pad |
| A pad the kernel sees but you cannot read | — | `game-devices-udev` |

```bash
paru -S xpadneo-dkms                    # Xbox pads over Bluetooth
paru -S xone-dkms xone-dongle-firmware  # the Xbox Wireless Adapter
paru -S dualsensectl                    # battery, lightbar, powering the pad off
paru -S game-devices-udev               # permissions for pads no rule covers yet
```

`paru` because that is what this was written on; the package names are the same in the AUR and mostly the same elsewhere. On Debian and Ubuntu it is `apt install dualsensectl game-devices-udev`, with `xpadneo-dkms` in unstable; on Fedora, `dnf install dualsensectl` and the two DKMS modules from upstream. Use whatever helper you already have — none of this is required, and the launcher drives every pad the kernel already exposes without any of it.

`xpadneo` and `xone` are DKMS modules: they want your kernel headers and they rebuild on every kernel update, and `xone` disables `xpad`, so install it only if you actually own the dongle. Debian has `xpadneo-dkms` in unstable, Fedora has neither, and upstream's installer is the path in both cases — [xpadneo](https://github.com/atar-axis/xpadneo), and [xone](https://github.com/dlundqvist/xone), which is the maintained fork.

### Checking what the kernel actually sees

The footer is the first test and costs nothing: no pad at all reads `NO GAMEPAD DETECTED`, and a pad the launcher is deliberately ignoring because another window took focus reads `WINDOW NOT FOCUSED — PAD INPUT PAUSED`. Past that, `evtest` names each button as you press it, which is how you find out whether a pad reports the standard layout or something this launcher will not recognise.

## Reporting a problem

**Attach `gfn-launcher.log`.** The launcher keeps its own log, and it is the one file worth sending: nearly everything that can go wrong here happens between this process and something outside it — the GeForce NOW client, the Flatpak portal, your compositor — and the log is the only place both halves of that conversation are written down.

Where it is depends on how you installed the launcher. The path is also printed in the launcher itself, at the bottom of **Settings → This launcher**, and on the screen it shows if the interface ever crashes.

| Install | Log file |
| --- | --- |
| Flatpak | `~/.var/app/io.github.robertotucci.GfnLauncher/config/gfn-launcher/logs/gfn-launcher.log` |
| AppImage, `.deb`, or from source | `~/.config/gfn-launcher/logs/gfn-launcher.log` |

The previous session's log is kept beside it as `gfn-launcher.log.1`, which is the one you want if the launcher restarted itself after whatever you are reporting. Together they are capped at two megabytes; nothing grows without bound.

```bash
# Flatpak
cp ~/.var/app/io.github.robertotucci.GfnLauncher/config/gfn-launcher/logs/gfn-launcher.log .

# everything else
cp ~/.config/gfn-launcher/logs/gfn-launcher.log .
```

### What is in it, and what is not

Every line is passed through a redaction step on its way to disk, so **no GeForce NOW credential reaches the file**: bearer tokens, JWTs, the `accessToken` and `idToken` the client stores, the account's email address and the machine's MAC address are all replaced before anything is written. That is belt and braces rather than the only defence — the modules that read NVIDIA's files return narrow, declared shapes and never log their contents — but it means the file is safe to paste into a public issue.

It **does** contain file paths from this machine, including your home directory, and the names of games you launched. Those are most of its value: half the failures worth reporting are a path that could not be read.

What it records is deliberately sparse — start-up and which install form this is, what the GeForce NOW client probe found, every game launch and the exact command used, whether the launcher got the screen back afterwards, host commands that failed or were slow, update checks and installs, and anything either process logged as a warning or an error.

### Worth saying alongside it

- Which install form, and the version — both are on the Settings screen and in the first line of the log
- Whether the session is Wayland or X11, and which desktop — also in the log's second line
- What you did, and what you expected instead

Open issues at [github.com/robertotucci/gfnlauncher/issues](https://github.com/robertotucci/gfnlauncher/issues).

## Documentation

- **[ARCHITECTURE.md](./ARCHITECTURE.md)** — how it is built and why, including the constraints worth knowing before changing anything
- **[CONTRIBUTING.md](./CONTRIBUTING.md)** — development setup, conventions, release process
- **[docs/gfn-api.md](./docs/gfn-api.md)** — the GeForce NOW client API: endpoints, GraphQL documents, the launch deep link, and how each fact was derived

## Relationship to NVIDIA

None. This is an unofficial, independent project, not affiliated with or endorsed by NVIDIA. It does not stream anything itself and it does not reimplement the client: it browses the catalog and hands a deep link to the GeForce NOW client you already installed. "GeForce NOW", "NVIDIA" and "RTX" are trademarks of NVIDIA Corporation.

The API notes in `docs/gfn-api.md` were derived by observing a legally installed client on the author's own machine, and are published so that the code here can be read and audited rather than taken on trust.

## Licence

Copyright (C) 2026 Roberto Tucci.

Released under the [GNU Affero General Public License v3.0](./LICENSE). You may use, study, modify and redistribute it; if you distribute a modified version — or run one as a network service — you must release your changes under the same licence.
