/** Canonical IPC channel names. Import these instead of writing string literals. */
export const IPC = {
  gfnInfo: 'gfn:info',
  gfnLaunch: 'gfn:launch',
  gfnOpen: 'gfn:open',
  catalogGet: 'catalog:get',
  catalogRefresh: 'catalog:refresh',
  catalogDetails: 'catalog:details',
  libraryProviders: 'library:providers',
  librarySync: 'library:sync',
  librarySyncAll: 'library:syncAll',
  librarySetOwned: 'library:setOwned',
  librarySelectVariant: 'library:selectVariant',
  authStatus: 'auth:status',
  authSignIn: 'auth:signIn',
  authSignOut: 'auth:signOut',
  statusGet: 'status:get',
  statusRefresh: 'status:refresh',
  recentList: 'recent:list',
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  appQuit: 'app:quit',
  appMinimize: 'app:minimize',
  appPower: 'app:power'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
