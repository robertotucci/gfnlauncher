import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/ipc'
import type { BluetoothAction } from '@shared/bluetooth'
import type { ScreenOwnership } from '@shared/input'
import type {
  GfnClientInfo,
  LaunchRequest,
  LauncherApi,
  PowerAction,
  Settings,
  UpdateProgress,
  ZoneStatus
} from '@shared/types'

/**
 * The entire privileged surface available to the UI. Every method is an
 * explicit passthrough — no generic `invoke(channel, ...)` escape hatch, so the
 * renderer can only reach channels listed here.
 */
const api: LauncherApi = {
  gfn: {
    info: () => ipcRenderer.invoke(IPC.gfnInfo),
    onClient: (listener: (info: GfnClientInfo) => void) => {
      const forward = (_event: unknown, info: GfnClientInfo): void => listener(info)
      ipcRenderer.on(IPC.gfnClient, forward)
      return () => {
        ipcRenderer.off(IPC.gfnClient, forward)
      }
    },
    launch: (request: LaunchRequest) => ipcRenderer.invoke(IPC.gfnLaunch, request),
    open: () => ipcRenderer.invoke(IPC.gfnOpen)
  },
  catalog: {
    get: () => ipcRenderer.invoke(IPC.catalogGet),
    refresh: () => ipcRenderer.invoke(IPC.catalogRefresh),
    details: (cmsId: string) => ipcRenderer.invoke(IPC.catalogDetails, cmsId)
  },
  library: {
    providers: () => ipcRenderer.invoke(IPC.libraryProviders),
    sync: (providerId: string) => ipcRenderer.invoke(IPC.librarySync, providerId),
    syncAll: () => ipcRenderer.invoke(IPC.librarySyncAll),
    setOwned: (cmsId: string, variantId: string, owned: boolean) =>
      ipcRenderer.invoke(IPC.librarySetOwned, cmsId, variantId, owned),
    selectVariant: (cmsId: string, variantId: string) =>
      ipcRenderer.invoke(IPC.librarySelectVariant, cmsId, variantId)
  },
  auth: {
    status: () => ipcRenderer.invoke(IPC.authStatus),
    signIn: () => ipcRenderer.invoke(IPC.authSignIn),
    signOut: () => ipcRenderer.invoke(IPC.authSignOut)
  },
  status: {
    get: () => ipcRenderer.invoke(IPC.statusGet),
    refresh: () => ipcRenderer.invoke(IPC.statusRefresh),
    onZone: (listener: (zone: ZoneStatus) => void) => {
      const forward = (_event: unknown, zone: ZoneStatus): void => listener(zone)
      ipcRenderer.on(IPC.statusZone, forward)
      return () => {
        ipcRenderer.off(IPC.statusZone, forward)
      }
    }
  },
  // Five passthroughs and no subscription, unlike every other live surface
  // here. The Devices screen knows it is watching a moving list, so it polls
  // `get()` — which is answered from a model in main that D-Bus signals keep
  // current, and therefore costs nothing on the bus.
  bluetooth: {
    get: () => ipcRenderer.invoke(IPC.bluetoothGet),
    scan: (on: boolean) => ipcRenderer.invoke(IPC.bluetoothScan, on),
    power: (on: boolean) => ipcRenderer.invoke(IPC.bluetoothPower, on),
    act: (action: BluetoothAction, address: string) =>
      ipcRenderer.invoke(IPC.bluetoothAct, action, address),
    respond: (accept: boolean) => ipcRenderer.invoke(IPC.bluetoothRespond, accept)
  },
  recent: {
    list: () => ipcRenderer.invoke(IPC.recentList)
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.settingsGet),
    update: (patch: Partial<Settings>) => ipcRenderer.invoke(IPC.settingsUpdate, patch)
  },
  update: {
    check: (force: boolean) => ipcRenderer.invoke(IPC.updateCheck, force),
    apply: () => ipcRenderer.invoke(IPC.updateApply),
    restart: () => ipcRenderer.invoke(IPC.updateRestart),
    /**
     * The shape every subscription on this bridge is written in, and the reason
     * they are written out rather than exposed as a generic `on(channel, …)`:
     * the same rule that keeps `invoke` off this object applies in reverse. The
     * renderer can listen to the four channels named here and to nothing else.
     *
     * The listener is handed the payload alone. `IpcRendererEvent` carries a
     * `sender`, and a live `ipcRenderer` handle reaching the renderer would
     * undo the whole arrangement — so the event stays on this side and only
     * data crosses. Each one returns its own unsubscribe, which is what a React
     * effect can return directly as its cleanup.
     */
    onProgress: (listener: (progress: UpdateProgress) => void) => {
      const forward = (_event: unknown, progress: UpdateProgress): void => listener(progress)
      ipcRenderer.on(IPC.updateProgress, forward)
      return () => {
        ipcRenderer.off(IPC.updateProgress, forward)
      }
    }
  },
  app: {
    quit: () => ipcRenderer.invoke(IPC.appQuit),
    minimize: () => ipcRenderer.invoke(IPC.appMinimize),
    power: (action: PowerAction) => ipcRenderer.invoke(IPC.appPower, action),
    openDonation: () => ipcRenderer.invoke(IPC.appOpenDonation),
    // The one channel here that does not `invoke`. There is no result to wait
    // for and no failure the renderer could act on, and a promise nobody awaits
    // is a worse description of that than a send.
    padActivity: () => ipcRenderer.send(IPC.appPadActivity),
    diagnostics: () => ipcRenderer.invoke(IPC.appDiagnostics),
    /** Written out the long way for the reasons on `update.onProgress` above. */
    onScreen: (listener: (screen: ScreenOwnership) => void) => {
      const forward = (_event: unknown, screen: ScreenOwnership): void => listener(screen)
      ipcRenderer.on(IPC.appScreen, forward)
      return () => {
        ipcRenderer.off(IPC.appScreen, forward)
      }
    },
    /** The fifth, and the last one this bridge should grow. Same shape. */
    onPointerMode: (listener: (active: boolean) => void) => {
      const forward = (_event: unknown, active: boolean): void => listener(active)
      ipcRenderer.on(IPC.pointerMode, forward)
      return () => {
        ipcRenderer.off(IPC.pointerMode, forward)
      }
    }
  }
}

contextBridge.exposeInMainWorld('launcher', api)
