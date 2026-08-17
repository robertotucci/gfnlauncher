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
  updateCheck: 'update:check',
  updateApply: 'update:apply',
  updateRestart: 'update:restart',
  /**
   * Main → renderer, and the only channel on this boundary that travels that
   * way. Everything else here is a request the renderer makes; this one is a
   * byte count during a download nobody can otherwise watch.
   */
  updateProgress: 'update:progress',
  appQuit: 'app:quit',
  appMinimize: 'app:minimize',
  appPower: 'app:power',
  appOpenDonation: 'app:openDonation',
  appPadActivity: 'app:padActivity',
  /**
   * Where the log file is, and what this build is.
   *
   * The third channel on this boundary with no payload, and for the same reason
   * as `app:openDonation` and `app:padActivity` — there is no argument to
   * forge. It exists so the launcher can print the path to its own log on
   * screen: a bug report that has to begin with "which file do I attach" is one
   * most people do not begin.
   */
  appDiagnostics: 'app:diagnostics'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
