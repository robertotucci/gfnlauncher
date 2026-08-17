import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/ipc'
import type {
  LaunchRequest,
  LauncherApi,
  PowerAction,
  Settings,
  UpdateProgress
} from '@shared/types'

/**
 * The entire privileged surface available to the UI. Every method is an
 * explicit passthrough — no generic `invoke(channel, ...)` escape hatch, so the
 * renderer can only reach channels listed here.
 */
const api: LauncherApi = {
  gfn: {
    info: () => ipcRenderer.invoke(IPC.gfnInfo),
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
    refresh: () => ipcRenderer.invoke(IPC.statusRefresh)
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
     * The one subscription on this bridge, and the reason it is written out
     * rather than exposed as a generic `on(channel, …)`: the same rule that
     * keeps `invoke` off this object applies in reverse. The renderer can
     * listen to this and to nothing else.
     *
     * The listener is handed the payload alone. `IpcRendererEvent` carries a
     * `sender`, and a live `ipcRenderer` handle reaching the renderer would
     * undo the whole arrangement — so the event stays on this side and only
     * data crosses.
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
    diagnostics: () => ipcRenderer.invoke(IPC.appDiagnostics)
  }
}

contextBridge.exposeInMainWorld('launcher', api)
