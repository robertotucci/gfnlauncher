import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/ipc'
import type { LaunchRequest, LauncherApi, PowerAction, Settings } from '@shared/types'

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
  app: {
    quit: () => ipcRenderer.invoke(IPC.appQuit),
    minimize: () => ipcRenderer.invoke(IPC.appMinimize),
    power: (action: PowerAction) => ipcRenderer.invoke(IPC.appPower, action)
  }
}

contextBridge.exposeInMainWorld('launcher', api)
