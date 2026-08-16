# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Release notes on GitHub and the AppStream `<releases>` block are both generated from this file.

## [Unreleased]

## [0.1.0] - 2026-08-16

First public release.

### Added

- **Gamepad-only 10-foot interface.** One `requestAnimationFrame` loop turns pad hardware into intents; a spatial focus model moves the cursor by geometry rather than DOM order, so pressing down lands in the same column. Xbox, PlayStation and 8BitDo pads are all recognised, and the footer legend redraws itself to match the controller in your hands — or switches to keycaps when you unplug it.
- **Full GeForce NOW catalogue**, around 5 900 titles, with genre filtering, an RTX filter, and server-side search driven from an on-screen alphabetical keyboard.
- **Library and ownership.** Sign in through NVIDIA's own login page in a window the launcher owns; your linked stores' libraries appear automatically. Store chips in the details panel pick which edition launches, for the ~850 titles that exist on more than one store.
- **Details panel** with description, screenshots, supported controls, subscription tier and a QR code for the store page — because a link is useless on a TV with no browser, and a code moves it to the phone in the room.
- **Recent**, a chronology of what you played.
- **Status screen** that opens with *your* datacenter rather than a list of 76, read from the client's own routing configuration on disk. No account, no network needed for that half.
- **Settings**: accent colour (seven presets), interface scale (75–175%), fullscreen, autostart, launch mode, library sync, and a row that hands the screen to the real GeForce NOW client for the things this launcher does not mirror.
- **Power menu** — back to desktop, sleep, restart, turn off — because the launcher is the last thing on screen before the TV goes off.
- **Autostart** via a standard XDG desktop entry, so the launcher comes up with the session.
- **Offline behaviour.** Fonts are self-hosted, the catalogue is cached on disk, and a machine that has never fetched anything still shows a usable interface.

### Packaging

- Flatpak, the recommended install on any distribution.
- AppImage and `.deb` for anyone who would rather not use Flatpak.
- x86_64 only, matching the GeForce NOW client.

[Unreleased]: https://github.com/robertotucci/gfn-launcher/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/robertotucci/gfn-launcher/releases/tag/v0.1.0
