# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

## Read these first

**[ARCHITECTURE.md](./ARCHITECTURE.md) is the primary reference** and carries what used to live in this file: the three Electron contexts, the input and focus model, the GeForce NOW integration, the four backends, the two caches, the design rules, power and autostart. Read the section covering the area you are about to change *before* changing it — nearly every non-obvious line in this codebase is non-obvious deliberately, and the reasoning is recorded there.

Two more:

- **[docs/gfn-api.md](./docs/gfn-api.md)** — endpoints, every GraphQL document, the launch deep link, and how each fact was derived. Read it before touching `src/main/gfn/`.
- **[CONTRIBUTING.md](./CONTRIBUTING.md)** — commands, conventions, and what has to be checked by hand.

## Operating rules specific to working here as an agent

**A second `npm run dev` looks like it worked and is not.** `src/main/index.ts` takes a single-instance lock, so the new Electron builds, quits immediately, and the `second-instance` handler refocuses the *old* window — still running the code from before your edits. The tell is `Port 5173 is in use, trying another one`. Before debugging any "my change did not apply" symptom, run `ps -eo pid,etime,cmd | grep electron-vite`: an elapsed time older than the edit means you are looking at a stale window, not a bug.

**Never paste a token into this repository or into a message.** Three files on this machine contain live credentials and are read by code here:

- `~/.var/app/com.nvidia.geforcenow/.local/state/NVIDIA/GeForceNOW/sharedstorage.json` — bearer token, an `idToken` JWT with the user's email, the machine's MAC address.
- `~/.var/app/com.nvidia.geforcenow/.local/state/NVIDIA/GeForceNOW/console.log` — tokens.
- The `persist:gfn-session` partition under the launcher's own `userData`.

Grep them, never cat them, and never quote a matched line wholesale. `parseZoneAssignment` in `src/main/status/zone.ts` returns six declared fields for this reason, and `zone.test.ts` asserts that key set — do not widen either.

**Do not re-litigate the rejected approaches.** `docs/gfn-api.md` records the evidence for each dead end (reusing the desktop client's on-disk token, borrowing GFN's OAuth client, registering our own, the `keywords` field as an RTX source, `prod/v2/serverInfo` on the status path). Reopening one needs new information, not a fresh guess.

**When probing the public GraphQL API, try `X { __typename }` before concluding `X` does not exist.** A bare object-typed field is an invalid document, and the gateway answers that with the same opaque 500 it gives an unknown field.

**Match the conventions in CONTRIBUTING.md rather than inventing new ones** — in particular: every constructed argv is a pure function with a test, everything crossing the IPC bridge is validated on the main side, and no failure is swallowed.
