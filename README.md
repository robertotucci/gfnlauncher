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

You do not need a GeForce NOW account to browse or to launch: the deep link goes to the local client, so **launching games works signed out**. Signing in adds your library and ownership.

## Install

**You already have Flatpak.** GeForce NOW on Linux *is* a Flatpak, so the one prerequisite for the recommended install is the same thing this launcher requires anyway. Nothing new to adopt.

### Flatpak — recommended, any distribution, automatic updates

```bash
flatpak install flathub io.github.robertotucci.GfnLauncher
flatpak run io.github.robertotucci.GfnLauncher
```

> Flathub submission is in progress. Until it lands, use the bundle below — it installs the same build.

### Flatpak bundle — from the Releases page

Works on every distribution, offline, and needs no remote. It does **not** update itself: you download a new bundle each release.

```bash
flatpak install --user ./GfnLauncher-<version>.flatpak
```

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

## What is in it

- **Grid** of the whole GeForce NOW catalog (~5 900 titles), with genre filtering and an RTX filter
- **Library** view of what you own, once signed in
- **Recent** — what you played, in the order you played it
- **Search**, server-side, driven from the on-screen keyboard
- **Details panel** — description, screenshots, supported controls, subscription tier, and store chips for picking which store's edition launches
- **Status** — GeForce NOW service health, opening with *your* datacenter rather than a list of 76. Read from the client's own routing configuration on this disk, so it needs no account and works offline
- **Settings** — sign-in, library sync, accent colour, interface scale (75–175%), fullscreen, autostart, launch mode
- **Power** — back to desktop, sleep, restart, turn off. The launcher is the last thing on screen before the TV goes off

## Signing in

Open **Settings** (Y) and choose **Sign in to GeForce NOW**. NVIDIA's own sign-in page opens in a window the launcher owns; log in as you normally would. The session persists, so this is a one-time step.

Two honest caveats:

- **Sign-in needs a mouse and keyboard.** NVIDIA's login page is not gamepad-navigable. Everything after it is, and if there is no keyboard near the television, [a pointer driven from the pad](#a-pointer-and-a-keyboard-on-the-pad--antimicrox) stands in for one.
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
| `--talk-name=org.gnome.SessionManager`, `…PowerManagement`, `…ScreenSaver` | Asking the session not to blank the screen while you are browsing with the pad. Three names because each desktop answers on a different one, rather than the whole session bus for one call |
| `--filesystem=~/.var/app/com.nvidia.geforcenow:ro` | Reading which datacenter your client is set to stream from, for the Status screen |
| `--filesystem=…/flatpak/app/com.nvidia.geforcenow:ro` | Reading the GeForce NOW client's own service configuration instead of hardcoding NVIDIA's hostnames |
| `--share=network` | The catalog, sign-in, and the status page |
| `--socket=wayland`, `--socket=fallback-x11`, `--share=ipc` | Drawing a window |
| `--socket=pulseaudio` | Sound, for the web-player fallback |

**`--talk-name=org.freedesktop.Flatpak` is effectively an exit from the sandbox**, and there is no way around it for an app whose entire purpose is to drive another Flatpak. There is no portal for "launch this Flatpak with these arguments" — the deep link is an argv, not a URI scheme — and stopping a running client needs the host too. If that trade is not one you want to make, the AppImage does the same things with no sandbox at all, which is at least honest about it.

It is also the *only* permission that leaves the sandbox. The autostart entry goes through it rather than through a second `--filesystem=xdg-config/autostart:create`, precisely so there is one door to inspect rather than two. The three names under it are ordinary session services being asked a question; none of them can run anything.

Every permission can be revoked with [Flatseal](https://flathub.org/apps/com.github.tchx84.Flatseal) or `flatpak override`. Revoke the host one and the launcher will tell you what is missing rather than pretending GeForce NOW is not installed. Revoke the three screen ones and nothing will say so — a blocked Inhibit call still looks like it succeeded from inside the sandbox, and all you see is the screen going dark while you browse, which is what it did before it asked.

## Waking the machine with the pad

Not something the launcher can do — `/sys/bus/usb/devices/*/power/wakeup` is root-owned. It takes one udev rule, written up in [docs/wake-on-gamepad.md](./docs/wake-on-gamepad.md).

## Things worth installing around it

None of this is required, and none of it is bundled. The launcher drives whatever pad the kernel already exposes, and on a current kernel that is every pad worth naming. These are the places a television setup runs out of road, and the smallest thing that fills each.

### A pointer and a keyboard on the pad — AntiMicroX

This closes the two gaps the launcher admits to. NVIDIA's sign-in page is not gamepad-navigable, and the desktop you land on after **Back to desktop** cannot be left with a pad either — the Gamepad API only reports to a focused window, so a blurred launcher is a deaf one. The catalogue adds a third: 1 835 of its titles are keyboard-and-mouse only. [AntiMicroX](https://github.com/AntiMicroX/antimicrox) maps sticks to a pointer and buttons to keys through `/dev/uinput`, which is kernel-side — so the launcher, the GeForce NOW client and the stream all see an ordinary mouse and keyboard, sandbox or no sandbox.

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

Packaged as `joystickwake` in Debian unstable and Ubuntu 26.10; everywhere else it is one Python file to copy into your `PATH`. On Plasma under Wayland the stock wake commands do not take, and it needs the custom one documented upstream.

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

`xpadneo` and `xone` are DKMS modules: they want your kernel headers and they rebuild on every kernel update, and `xone` disables `xpad`, so install it only if you actually own the dongle. Debian has `xpadneo-dkms` in unstable, Fedora has neither, and upstream's installer is the path in both cases — [xpadneo](https://github.com/atar-axis/xpadneo), and [xone](https://github.com/dlundqvist/xone), which is the maintained fork.

### Checking what the kernel actually sees

The footer is the first test and costs nothing: no pad at all reads `NO GAMEPAD DETECTED`, and a pad the launcher cannot hear because another window took focus reads `WINDOW NOT FOCUSED — PAD INPUT PAUSED`. Past that, `evtest` names each button as you press it, which is how you find out whether a pad reports the standard layout or something this launcher will not recognise.

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
