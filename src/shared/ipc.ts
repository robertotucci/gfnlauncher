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
  /**
   * Bluetooth, and the five channels that are deliberately all pulls.
   *
   * `bluetooth:get` answers out of a model in `src/main/bluetooth/` that D-Bus
   * signals keep current, so the Devices screen polling it once a second costs
   * no bus traffic — and the bridge does not grow a sixth main → renderer push
   * for a list the renderer already knows it is watching. That is the test the
   * five pushes below pass and this would not.
   *
   * Everything crossing here is validated on the main side: `isBluetoothAction`
   * for the verb, `isBluetoothAddress` for the key, and then the address is
   * *resolved against main's own model* rather than built into an object path,
   * so nothing the renderer sends can name a D-Bus object the launcher has not
   * itself discovered.
   */
  bluetoothGet: 'bluetooth:get',
  bluetoothScan: 'bluetooth:scan',
  bluetoothPower: 'bluetooth:power',
  bluetoothAct: 'bluetooth:act',
  /** Answers the pairing confirmation BlueZ is holding a call open for. */
  bluetoothRespond: 'bluetooth:respond',
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
   * What each connected controller says about itself.
   *
   * A **pull**, and it passes the test the five pushes had to pass in reverse:
   * the renderer plainly knows there is something to ask about, because it is
   * the thing holding the `Gamepad` whose `mapping` came back empty. So it asks
   * once per hot-plug rather than being told sixty times a second.
   *
   * What comes back is `PadProfile[]` — the numbering the *kernel* gives each
   * pad, which is what the browser is reporting whenever it has no standard
   * mapping of its own. See `@shared/padLayout`.
   */
  padList: 'pad:list',
  /**
   * Pointer mode, and the only channel here that is **not** on the bridge.
   *
   * It runs preload → main from `src/preload/pointer.ts`, which is mounted on
   * the two windows that render somebody else's page — the sign-in window and
   * the web player. Those windows get no `contextBridge` and never will, so
   * this cannot appear in `preload/index.ts` beside the rest: the whole point
   * of that preload is that it exposes nothing, and the page it shares a
   * process with can no more reach this channel than it can reach `ipcRenderer`.
   *
   * `isPointerCommand` in `@shared/pointer` validates every payload on the main
   * side, which matters more here than on the bridge. What arrives is replayed
   * as *trusted* input into the very page that hosts the sender.
   */
  pointerEvent: 'pointer:event',
  /**
   * The answer half of `pointer:event`, main → the pointer preload.
   *
   * It exists because a document is not a session. Signing in walks through
   * three or four navigations — the mall, NVIDIA's login, the password step —
   * and each one re-executes the preload with a fresh, empty state. Without
   * this the cursor would vanish at every step and the user would have to hold
   * the chord again to get through a single form.
   *
   * Main remembers the mode per window and replays it into each new document.
   * It is also how main can *end* the mode, which is the half that matters when
   * something goes wrong.
   *
   * The payload is `PointerRestore`, and it carries the accent and the keyboard
   * size along with the mode. That preload cannot read settings — it exposes
   * nothing and invokes nothing — and this is its only inbound channel, so a
   * second one for two values would be a second thing to keep in step. Main
   * re-sends it whenever those settings change, which is what makes a keyboard
   * already on screen follow the accent rather than wait for a navigation.
   */
  pointerRestore: 'pointer:restore',
  /**
   * Main → renderer: the desktop cursor is up.
   *
   * **The fifth of the main → renderer channels**, and it has to pass the test
   * the other four set out below: the renderer cannot ask, because it has no
   * way of knowing there is anything to ask about. It passes. The mode is armed
   * by a chord read off `/dev/input/js*` in main, which the renderer cannot see
   * at all — that reader exists precisely because the renderer is asleep or
   * suspended in the two situations this serves.
   *
   * It is needed because with a cursor over the launcher the left stick must
   * move the cursor and **not** also walk the grid underneath it. The renderer
   * suppresses its own intents while this is true. That is a mode check before
   * `emit` and deliberately *not* a change to `shouldAcceptInput`, which stays
   * exactly as it is.
   */
  pointerMode: 'pointer:mode',
  /**
   * The composed keyboard, both ways.
   *
   * `composeView` is main pushing what to draw — the text so far, which layer
   * is up, which key the pad is on — into the window that draws it. That window
   * holds no state of its own on purpose: main reads the pad from joydev, so
   * main is the only place that knows what the selection is.
   *
   * It also carries four things the *stylesheet* cannot know and the page has
   * no way to ask for: the user's accent, the size they chose for the keyboard,
   * how many rows this layout draws, and how much of the bottom of the window
   * the compositor left unusable. The payload is one type, `ComposeView` in
   * `@shared/keyboardLayout`, imported by main, the preload and the page — it
   * was three hand-kept copies once, and the one that sent it was not even a
   * type.
   *
   * `composePress` is the way back, and it exists for one thing: with a cursor
   * already on screen, the keys are also *clickable*, and a keyboard you can
   * see and cannot click reads as broken. It carries a button name, checked on
   * the main side against the layout and against the sender, like everything
   * else on this boundary.
   */
  composeView: 'compose:view',
  composePress: 'compose:press',
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
