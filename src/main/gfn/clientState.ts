import { homedir } from 'node:os'
import { join } from 'node:path'
import { GFN_APP_ID } from './flatpak'

/**
 * Where the GeForce NOW client keeps its state, said once.
 *
 *   ~/.var/app/com.nvidia.geforcenow/.local/state/NVIDIA/GeForceNOW/
 *
 * The path looks incidental and is not: the client's Flatpak manifest declares
 * `persistent=.local/state` and unsets `XDG_STATE_HOME`, so the container's
 * state directory is bound there. (It is *not* the host-side
 * `~/.local/state/NVIDIA/GeForceNOW/`, which only holds the wrapper's log.)
 *
 * Three modules read inside it — `status/zone.ts` and `gfn/clientSettings.ts`
 * the storage file, `gfn/streamLog.ts` the stream log — and `clientWatch.ts`
 * watches the storage file. They used to build the path each for themselves;
 * one definition means a watch cannot end up pointed somewhere the reader is
 * not, and the writer cannot end up writing somewhere the reader does not look.
 *
 * Functions taking `home` rather than constants: `homedir()` is cheap, and a
 * constant evaluated at import time is one no test can move.
 */
export function clientStateDir(home: string = homedir()): string {
  return join(home, '.var', 'app', GFN_APP_ID, '.local', 'state', 'NVIDIA', 'GeForceNOW')
}

/**
 * `sharedstorage.json` — the client's datacenter, its streaming settings, and a
 * live bearer token, an `idToken` JWT with the account's email, and the
 * machine's MAC address. Handled with tongs everywhere it is read; see the
 * headers of `status/zone.ts` and `gfn/clientSettings.ts`.
 */
export function clientStoragePath(home: string = homedir()): string {
  return join(clientStateDir(home), 'sharedstorage.json')
}
