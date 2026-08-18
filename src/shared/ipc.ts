/** Canonical IPC channel names. Import these instead of writing string literals. */
export const IPC = {
  gfnInfo: 'gfn:info',
  /**
   * The push half of `gfn:info`, carrying the same `GfnClientInfo`.
   *
   * A client that updates, is installed or is removed while the launcher is
   * open does none of it through us — the renderer has nothing to ask and no
   * moment at which to ask it. `clientWatch.ts` is the only side that can
   * notice, so it is the side that tells.
   */
  gfnClient: 'gfn:client',
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
  /**
   * Just the zone out of a `StatusSnapshot`, when the client's routing moves.
   *
   * The nameplate is read from a file in another application's state directory,
   * and the user changes it *in that application* — so the launcher is behind
   * them when it happens, and a screen left open on the sofa would otherwise
   * keep naming the datacenter they left. `clientWatch.ts` resolves it against
   * the board already cached in `status/index.ts`, so this costs no request.
   *
   * The zone alone, not a whole snapshot: the rest of that board has its own
   * freshness and its own error, and inventing values for them here would make
   * a stale fetch look like a fresh one.
   */
  statusZone: 'status:zone',
  recentList: 'recent:list',
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  updateCheck: 'update:check',
  updateApply: 'update:apply',
  updateRestart: 'update:restart',
  /**
   * Main → renderer, the first of four. Everything else here is a request the
   * renderer makes; this one is a byte count during a download nobody can
   * otherwise watch.
   *
   * The four are `update:progress`, `app:screen`, `gfn:client` and
   * `status:zone`, and each carries its own argument above for why the renderer
   * cannot simply ask. That argument is the entry fee: there is no generic
   * `on(channel, …)` on the bridge, so a channel is a hand-written passthrough
   * in `preload/index.ts` and a declared method on `LauncherApi`.
   */
  updateProgress: 'update:progress',
  appQuit: 'app:quit',
  /**
   * Who has the screen.
   *
   * The renderer cannot work this out for itself. It knows whether it has focus
   * and nothing else, and "the GeForce NOW client is streaming on top of me"
   * and "a notification took the focus for a second" want opposite answers —
   * see `shouldAcceptInput` in `@shared/input`. Only main knows which it is,
   * because only main started the thing in front.
   */
  appScreen: 'app:screen',
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
