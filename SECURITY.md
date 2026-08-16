# Security

## Reporting a vulnerability

Use [GitHub's private vulnerability reporting](https://github.com/robertotucci/gfnlauncher/security/advisories/new) rather than a public issue. I will acknowledge within a few days; this is a spare-time project, so please allow for that before disclosing.

## What this program touches that is worth knowing about

**It holds a GeForce NOW session.** Signing in opens NVIDIA's own login page in a window the launcher owns and reads the bearer token off the requests that window makes. **The token is never written to disk** — only the browser partition's cookie jar persists, which is the right place for a cookie jar. Anything that would cause the token to be logged, serialised into the catalog cache, or sent anywhere other than NVIDIA's own endpoints is a bug worth reporting.

**It reads a file full of secrets, on purpose, and deliberately returns almost nothing from it.** The Status screen reads the GeForce NOW client's `sharedstorage.json`, which contains a live access token, an `idToken` JWT carrying the user's email address and NVIDIA user id, the machine's MAC address, its LAN IP and the router's MAC. `parseZoneAssignment` in `src/main/status/zone.ts` reads three subtrees and returns six declared fields; the parsed root is never logged, never returned, and never spread into anything, and `zone.test.ts` asserts the exact key set against a fixture containing a session blob. A change that widens that return type, or logs the object rather than a field, is a leak of the user's email to the renderer.

**It reaches the host, and says so.** Packaged as a Flatpak it holds `--talk-name=org.freedesktop.Flatpak`, which is effectively an exit from the sandbox. Everything that uses it goes through `src/main/host.ts`; the README explains what each permission is for. If you find a path that reaches the host without going through that module, that is worth reporting even if it is not exploitable — the point of the single choke point is that it can be audited.

**The renderer is not trusted.** `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, and the preload exposes named passthroughs with no generic `invoke(channel, …)` escape hatch, so the renderer can only reach the channels in `src/shared/ipc.ts`. Every payload crossing that boundary is validated on the main side before it becomes an argument to anything — `isPowerAction` before `systemctl`, `isLaunchRequest` before a deep link, `isAccentId` before a CSS custom property. A channel that skips its validator is a bug regardless of whether a path to it exists today.

## Not vulnerabilities

- **The launcher can suspend, reboot and power off the machine.** That is a feature, mediated by logind and polkit, using no privilege the user does not already have from a terminal.
- **`docs/gfn-api.md` documents NVIDIA endpoints.** They are the ones an installed client already calls, observed on the author's own machine. No credential, token or account identifier from a real session appears in this repository.

## Supported versions

The most recent release. This is a small project; there is no backport branch.
