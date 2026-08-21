# GeForce NOW client API — reference

Everything here was derived by static analysis of the installed Flatpak
(`com.nvidia.geforcenow`, v2.0.87.130): the CEF binary, the wrapper script, the
bundled Angular app in `files/mall/*.js`, and the on-disk HTTP cache.

These are private, undocumented APIs. NVIDIA owes them no stability. Treat every
response as untrusted and make a schema change degrade the launcher, not break it.

```bash
flatpak info --show-location com.nvidia.geforcenow   # install root
```

## Launching a game

The CEF binary understands:

```
--url-route="#?cmsId=<ID>&launchSource=<SRC>&shortName=<NAME>&parentGameId=<PID>"
```

That template is not inferred — the binary's own string table holds it
contiguously, in this order, because it is how the client relaunches *itself*:

```
 --url-route="#?      cmsId=      &launchSource=      &shortName=      &parentGameId=
```

**The Flatpak wrapper discards argv.** `/app/bin/GeForceNOW` reads `$1` only as a
relaunch sentinel and then runs `./GeForceNOW` with no arguments, so
`flatpak run com.nvidia.geforcenow --url-route=…` silently opens the home screen.
Target the CEF binary directly and reproduce the wrapper's working directory:

```bash
flatpak run --command=/app/cef/GeForceNOW --cwd=/app/cef com.nvidia.geforcenow \
  --url-route="#?cmsId=<ID>&launchSource=External"
```

Bypassing also skips `GeForceNOW_Downloader` and the self-update check.

### Confirmed on this machine — v2.0.87.130, 16 August 2026

Cold start works, exactly as written above. The client logs the route verbatim:

```
[INFO:browser_app.cc(906)] urlRoute value is: #?cmsId=11285111&launchSource=External&shortName=warframe
```

and the Angular app consumes it — `console.log` shows
`Using streamer config: {"parentGameId":"","cmsId":11285111,"appLaunchMode":"Default",…}`.
Note `parentGameId` arriving as `""`: the app normalises the parameters we omit,
so omitting an empty optional and sending an empty one are the same thing.

**A running instance does not take a hand-off. It swallows the deep link.** This
was the open question and the answer is no. A second `flatpak run` carrying a
route reaches the *new* process, which logs it and then exits 0 in about a
millisecond without forwarding anything:

```
[INFO:browser_app_posix.cc(86)] Launched with URL route! #?cmsId=100362311&launchSource=External&…
[INFO gfn_crashdump_handler.cpp:252] Destroying custom crashdump handler
```

The running client never sees the id — grepping both logs for it returns
nothing, and the process count does not change. `Processing UrlRoute event` and
`Processing DesktopUrlRoute event` are the client's own internal navigation, not
an external entry point.

This is not an edge case: the client sits on the mall after a game exits, so it
is the normal state from the second launch of a session onwards. Anything
driving the deep link has to **end the running client first** — verified working
via `flatpak kill com.nvidia.geforcenow`, a settle wait, then the spawn.
`flatpak ps --columns=application` is the detection: one app id per line, no
header, empty and exit 0 when nothing runs. `flatpak kill` exits 1 with
"is not running" when there is nothing to kill.

### `launchSource` is telemetry, not behaviour

The bundle carries the whole enum, four values:

```js
N.Unknown = "Unknown", N.GeForceNOW = "GeForceNOW", N.External = "External", N.Deeplink = "Deeplink"
```

and maps it straight onto a telemetry dimension —
`launchSource === External ? "External" : launchSource === GeForceNOW ? "Mall" : …`.
It tags where a launch came from and selects nothing. `External` is both valid
and honest for an outside launcher.

### Corroboration from the Playnite extension

The `NVIDIAGeForceNowEnabler` extension for Playnite has shipped this same deep
link on Windows for years
(`darklinkpower/PlayniteExtensionsCollection`, `source/Library/NVIDIAGeForceNowLibrary`):

```
%LocalAppData%\NVIDIA Corporation\GeForceNOW\CEF\GeForceNOWStreamer.exe
  --url-route="#?cmsId={id}&launchSource=External&shortName=game_gfn_pc&parentGameId="
  workingDir: …\GeForceNOW\CEF
```

Which independently confirms three things we had only read out of the bundle:
the CEF binary is the right target and it wants its own directory as cwd;
`launchSource=External` is correct; and the id in the link is the **variant**
id, not the app-level `cmsId`. It also shows that an empty `parentGameId` is
accepted, and — the part that took a bug report to understand — that a constant
`shortName` works for every title.

### `shortName` must always be sent, or the client picks the store itself

**The value is inert. The presence is load-bearing.** This was recorded here as
"`shortName` is not load-bearing" for several releases, on the strength of
Playnite sending `game_gfn_pc` for everything, and that reading was wrong in the
one way that matters: a constant works, an *absent* parameter does not.

The client's `PlatformSelectionUIService` (`files/mall/614.*.js`, v2.0.88.129)
runs one state before the stream, and this is its whole input:

```js
onStateStarted() {
  let N = false
  if (!activeConfig.shortName) N = true              // ← the only test
  parentGameId ? …readLaunchMetaData… : cmsId ? this.finalizeStreamerConfig(N, cmsId.toString())
                                              : handleErrorState(MissingCmsId)
}

finalizeStreamerConfig(N, cmsId) {
  if (N) {                                           // no shortName → re-resolve
    getAppdata(cmsId, { isCmsId: true, includeLibraryFields: true })
    const f = variants.length === 1 ? variants[0]
                                    : variants.find(v => v.gfn.library?.selected)
    f ? (updateStreamerConfig(f.id, f.shortName), moveToNextState())
      : openPlatformSelectionDialog(…)               // ← the "Prima di giocare" picker
  } else {
    updateStreamerConfig(cmsId); moveToNextState()   // ← streams the variant we named
  }
}
```

The route parser defaults a missing `shortName` to `""`, so absent and empty are
the same falsy thing.

**And the re-resolution can never succeed for a multi-store title**, which is
what turns a detour into a dead end. Two lines apart in the bundle:

- `fetchAppdata` drops the flag on this branch — `j.isCmsId` selects
  `getAppDataQuery(true, j.useVpcIdWithCmsId)`, two arguments where the other
  branch passes three, so `includeLibraryFields` is never applied.
- `GetAppDataQueryForCmsId` selects `variants { gfn { library { installed
  playStatus } } }`. There is **no `selected`** in it.

So `variants.find(v => v.gfn.library?.selected)` is always `undefined` when the
app has more than one variant, and the picker opens however plainly the account
has already answered the question. Only `variants.length === 1` escapes, which
is why the symptom looked like "some titles".

Measured against a real 5.893-title signed-in cache: 613 multi-store titles
carry a slug on the harvested variant and were fine by accident; **234 do not
and asked every single time**, 30 of them owned. Battlefield 6 and Dishonored:
Death of the Outsider are both in that set.

The fallback the launcher sends is the **variant id**, in `launchShortName`
(`src/shared/games.ts`). Not an invention: the feed itself emits a numeric
`shortName` for 222 of the catalog's 6.917 variants and every one of them is
that variant's own id, and the client substitutes the app id by the same
reasoning wherever it meets a variant without a slug —
`(!V.shortName || "" === V.shortName) && (V.shortName = b.id)`, and
`launchStreamer(+S.id, S.shortName || l.id, …)` on the mall's own play button.

The full parameter set the route parser reads, for the record:
`cmsId`, `launchSource`, `shortName`, `appLaunchMode`
(`Default` | `GamepadFriendly` | `TouchFriendly`), `sdkClient`, `parentGameId`,
`accountLinked`, `cascadePreviewToken`, `locale`, `previewAtTime`. Only the
first three are sent. `appLaunchMode=GamepadFriendly` is the one of the rest
worth a look from a launcher driven by a pad, and it is unexplored.

## Presenting the client's window

The client only takes the whole screen once a stream is running. Everything
before that — the mall, the pre-launch dialog, the loading screen — is an
ordinary decorated window, restored at whatever size it was last left. Measured
on a 3840×2160 KDE Plasma 6 Wayland session, client v2.0.88.129:

```
WM_CLASS(STRING)             = "GeForceNOW", "GeForceNOW"
_NET_FRAME_EXTENTS(CARDINAL) = 0, 0, 48, 0      # a 48-pixel title bar
_NET_WM_STATE(ATOM)          = _NET_WM_STATE_FOCUSED
geometry                     = 2559x1355 @ 1082,342
```

The geometry comes back from
`~/.var/app/com.nvidia.geforcenow/.local/state/NVIDIA/GeForceNOW/storage.json`,
which holds `width`, `height`, `left`, `top` and a Windows-flavoured `showCmd`
(`1` = normal). The window is an **X11** one even here: the client runs under
XWayland, which its own `debug.log` records, and KWin reports the same class
lowercased as `resourceClass = geforcenow`.

### `nv-*` switches on the command line are ignored — do not try again

The binary carries a table of its own switches, read at `0x43cc00`–`0x43d600`
in v2.0.88.129 by a helper at `0x440ea0` that returns a compiled-in default when
the switch is absent and otherwise compares the value against the literal string
`"true"` (so `=false`, `=0` and `=no` are equally false, and only `=true` is
true). The window-shaped entries, name → default:

| Switch | Default |
| --- | --- |
| `nv-windows-borders` | true |
| `nv-window-persistence` | true |
| `nv-sdl-fullscreen-exclusive` | false |
| `nv-sdl-force-windowed` | false |
| `nv-sdl-resizable` | false — the shipped JSON sets it true |

Plus value switches `nv-native-window-size=W,H` and `nv-def-window-size=W,H`.

**None of them does anything when passed to the process.** The launcher already
bypasses the wrapper and hands `--url-route` straight to the CEF binary, so the
obvious next step is to hand it these too. It does not work, and here is the
evidence so nobody spends the evening again:

- `--nv-windows-borders=false`, `--nv-window-persistence=false` and
  `--nv-sdl-fullscreen-exclusive=true`, singly and together: the window comes up
  with the same 48-pixel frame at the same restored geometry.
- The decisive one, because it has a value that can be read back from outside:
  `--nv-min-window-size=1600,1000` leaves `WM_NORMAL_HINTS` reporting
  `program specified minimum size: 640 by 360` — the value in
  `/app/cef/Resources/GeForceNOW.json`.
- `--nv-remote-debugging-port=9333` opens no listening socket.
- `--nv-stdout=true` puts nothing on stdout.

The switches *reach* the process — `/proc/<pid>/cmdline` shows
`/app/cef/GeForceNOW --nv-sdl-fullscreen-exclusive=true --nv-windows-borders=false`
— and are simply not consulted. `Resources/GeForceNOW.json` is where the client
takes them from, and that file is inside the read-only Flatpak deployment.
`--url-route` is the exception, not the rule.

### What does work: ask the compositor

`_NET_WM_STATE_FULLSCREEN` on the client's window, which KWin honours for an
XWayland client. Both routes were measured and both produce the same thing —
`0,0`, `3840x2160`, `_NET_FRAME_EXTENTS = 0, 0, 0, 0`:

```bash
# EWMH, portable, needs xdotool on the host
xdotool search --onlyvisible --class GeForceNOW windowstate --add FULLSCREEN
```

```js
// KWin script, KDE only, needs no tool at all
window.noBorder = true
window.fullScreen = true
```

Two details decide the implementation in `src/main/gfn/present.ts`:

- **`--onlyvisible` is not optional.** The client owns four X11 windows of class
  `GeForceNOW`; three are unmapped helpers — one is SDL's `SDLGraphicsContext` —
  and they exist from the first second. Without the flag the search matches them
  and exits 0 before there is anything to fullscreen.
- **Match on `resourceClass`, never on `caption`**: at `windowAdded` the caption
  is still empty. `xdotool`'s `--name` filter is no use either — measured,
  `search --onlyvisible --all --class GeForceNOW --name 'GeForce NOW'` matches
  nothing even once the title is set, because SDL writes `_NET_WM_NAME` and
  `--name` reads the legacy `WM_NAME`. `getwindowname` does see it.

### Resizing the window before its page loads corrupts the client's layout

The obvious implementation — fullscreen the window the moment it appears — is
wrong, and it fails in a way that does not look like a window bug at all.

The Vulkan surface follows correctly; the client logs
`VkDrawable: 3840x2160  SDLWindow: 3840x2160`. What goes wrong is the CEF
viewport, which ends up at the window size multiplied by the resize ratio a
second time. On a 3840×2160 display, against a client whose saved geometry was
2559×1355:

```
viewport = 3840 × (3840/2559)  by  2160 × (2160/1355)  =  5762 × 3442
```

Two symptoms, both of which were reported before the cause was found:

- **A dialog the page centres is not centred.** It lands at 0.7503 × 0.7968 of
  the screen, because only the top-left 3840×2160 of that 5762×3442 layout is
  on screen. Measured off a screenshot of the "Prima di giocare" store picker.
- **Every stream is pillarboxed.** The video is fitted to the layout's aspect,
  5762/3442 = 1.674, so a 16:9 stream on a 16:9 screen is drawn 2160 × 1.674 =
  3615 px wide.

Measured three ways, with the sums closing exactly:

| fullscreen applied at | bands l/r/t/b | picture | aspect |
| --- | --- | --- | --- |
| `windowAdded` | 114 / 111 / 0 / 0 | 3615×2160 | 1.6736 |
| first `captionChanged` | 0 / 0 / 0 / 0 | 3840×2160 | 1.7778 |
| never — client's own fullscreen | 0 / 0 / 0 / 0 | 3840×2160 | 1.7778 |

The third row is the control and it names the culprit. The client resizing
*itself* to the same 3840×2160 when a stream starts lays out perfectly; only a
resize arriving from outside, before it is ready, is mishandled. `noBorder` is
not involved — `fullScreen` alone reproduces it identically.

**The fix is to wait for the window's title.** It is empty when the window is
added and the page sets it once it has a document, which is exactly the thing
that has to exist for a resize to be laid out against. On this machine
`captionChanged` fired 226 ms after `windowAdded`, and the window was still
2559×1403 at that point, so the deferral is real and not an accident of timing.
A fixed delay was deliberately rejected: an event moves with the machine it runs
on, a constant tuned on one machine does not.

## The web player — a second, separate route

`hmlendea/gfn-electron` is not another consumer of the deep link. It *is* a
client: it hosts NVIDIA's web app in its own `BrowserWindow`, and its
`--direct-start <cmsId>` is a deeper `loadURL` on that window
(`scripts/main.js`):

```
https://play.geforcenow.com/mall/#/streamer?launchSource=GeForceNOW&cmsId=<ID>
```

**The two routes are not interchangeable, because the two clients ship
different route tables.** The Flatpak's bundle declares `deeplink` and has no
`streamer` path at all; the web build has `streamer`. Sending either form to the
other target opens the home screen at best. The desktop client takes
`#?cmsId=…`; the web player takes `#/streamer?…`.

Verified here on 16 August 2026, in an Electron window on the launcher's own
`persist:gfn-session` partition:

- `https://play.geforcenow.com/mall/` loads signed in — the page renders the
  user's own library and "5 di 6 account connessi". A login captured by
  `webAuth` therefore carries into a stream window at no extra cost.
- `#/streamer?launchSource=External&cmsId=11285111` holds the route and renders
  the pre-launch dialog for that title, offering its stores. So `External` works
  on this route too, and the route does not auto-start a session.
- A spoofed Edge-on-Linux user agent is accepted; nothing rejected the client.
  `sec-ch-ua` was **not** overridden and nothing complained.

Two consequences worth knowing before touching `src/main/gfn/webStream.ts`:

- **The web route takes the same parameters, `shortName` included.** This entry
  previously said it took only a `cmsId` and could not pin a store; that was
  read off the URLs the launcher happened to build, not off the client. The two
  routes differ in *shape*, not in vocabulary — one parser serves both
  (`cmsId`, `launchSource`, `shortName`, `appLaunchMode`, `sdkClient`,
  `parentGameId`, `accountLinked`) and both feed the same `StreamerModule`, so
  the store-picker rule above applies here identically. The web path is still a
  fallback rather than a peer, but not for this reason.
- **`sec-ch-ua` cannot be set from there.** Electron keeps only the last
  `onBeforeSendHeaders` listener per session, and `webAuth` owns that hook on
  this partition — it attaches one for the length of a capture, then clears it
  with `null`. A second registration would silently disarm credential capture if
  a background `ensureSession` overlapped a launch. If hints ever become
  necessary, give the partition one hook owner that both callers register
  sub-handlers with.

## The public catalog feed — no sign-in

A **different service** from the GraphQL API below, with its own schema and no
authentication at all. It is what NVIDIA's own supported-games page and the
Playnite GeForce NOW extension read. `src/main/gfn/publicCatalog.ts`.

```
POST https://api-prod.nvidia.com/services/gfngames/v1/gameList
Content-Type: application/json
User-Agent: <required>
body: a bare GraphQL document
```

Probed live on 2026-08-15:

| Fact | Detail |
| --- | --- |
| Size | 5.889 titles (`country: US`), 5.890 (`IT`), 5.896 (`DE`) — region matters |
| Paging | 750 per page, 8 pages, ~6 s total; cursor is base64 of the offset (`NzUw` = `750`) |
| Body | the **bare document**. `{"query": …}` → 500, `application/graphql` → 500 |
| `User-Agent` | **mandatory**. Without one the edge drops the connection after the TLS handshake: no status, no body |
| Types | every entry came back `type: GAME`, every variant `osType: WINDOWS`, every variant had an id |

Fields confirmed to exist: `id` (GUID), `cmsId`, `title`, `sortName`, `type`,
`publisherName`, `developerName`, `genres`, `shortName`,
`images { GAME_BOX_ART TV_BANNER HERO_IMAGE KEY_ART }`,
`gfn { playabilityState minimumMembershipTierLabel catalogSkuStrings }`,
`variants { id title appStore osType storeId shortName storeUrl supportedControls publisherName gfn { releaseDate status } }`.

Rejected with a 500: `description`, `status`, `isFullyOptimized`,
`gfn { status }`, `images { LOGO | TITLE_TREATMENT | MARQUEE }`, `contentRating`,
`tags`, app-level `releaseDate`, and — importantly — the `searchQuery`,
`orderBy` and `filters` arguments. `first` works. `vpcId` is accepted but an
unrecognised zone silently cuts the result to a handful of titles, so do not
send one.

A second sweep on 2026-08-15, brute-forcing candidate names one at a time,
added these to the rejected list: `esrb`, `ageRating`, `pegi`, `rating`,
`userRating`, `maxPlayers`, `numberOfPlayers`, `features`, `category`,
`categories`, `franchise`, `series`, `earlyAccess`, `contentType`,
`marqueeScrimPrimaryRGB`, `storeLinks`, `website`, `tagline`, `popularity`,
`addedDate`, `relatedApps`, and app-level `parentGameId`. Two do exist and are
deliberately **not** requested:

| Field | Why not |
| --- | --- |
| `longDescription` | Localised prose, mean 1.511 characters against `shortDescription`'s 234 — roughly 7.5 MB more on the walk, and a wall of text at three metres. |
| `keywords` | Looks like Steam tags and is not usable as one: mean 141 per title, peaking at 449, carrying every localisation of every tag (`Action`, `Azione`, `Экшен`, `アクション`…) plus the game's own title in each language. ~29 MB, and a different `language` does not shrink it. `genres` — 20 clean codes — is the taxonomy to filter on. It also carries an `rtx` marker that is **not** the RTX list; see the trap below. |

`__typename` does answer, which is how the type names were recovered without
introspection: `AppQueryType`, `AppDataType`, `VariantDataType`,
`TitleGfnMetadata`, `AppImageTypeMap`, `GfnSubscriptionFeatureValue`.
`__type(name:)` returns null for an unknown name but 500s on a real one, so it
is not a way in.

### Ray tracing: `variants.gfn.features`

```graphql
variants {
  gfn {
    features {
      ... on GfnSubscriptionFeatureValue {
        key
        value
      }
    }
  }
}
```

Entries read `{ key: "RTX_ENABLED", value: "true" }`. The keys seen across the
catalog are `RTX_ENABLED` (275 variants, **171 titles**), `HDR_ENABLED` (340) and
`REFLEX_ENABLED` (119). **Only `"true"` is ever emitted** — an absent key is the
feed saying no, not saying nothing. The whole selection costs 0.58 MB across the
eight pages, which makes it the cheapest field in the query.

**The flag is per variant.** 154 titles carry it on every edition; 17 disagree —
Call of Duty: Black Ops 6 has it on one of four, Ghostwire: Tokyo on two of
three. A title still gets one badge, because the GFN web client resolves it that
way itself:

```js
// main.<hash>.js — GameFeaturesService / lcarsService
isFeatureSupportedOnGame(key, variants, v) {
  return variants.some(E => this.lcarsService.isFeatureSupportedOnVariant(E, key, v))
}
isFeatureSupportedOnVariant(H, _, Y) {
  const J = H?.gfn?.features
  return J.some(h => h.key === _ && (Y ? h.values?.includes(Y) : "true" === h.value))
}
```

#### The trap that hid this field

Probing candidate names one at a time — the method the two sweeps above used —
**cannot find an object-typed field**. `features` on its own is a 500, because a
field of object type is invalid without a subselection, and the gateway answers
an invalid document with the same bare Spring 500 it gives an unknown field.
`features { key }` is *also* a 500, because the declared type is abstract and
`key` is not on it. Only `features { __typename }` answers — with
`GfnSubscriptionFeatureValue`, which is then legal to spread.

So: **when probing this API, try `X { __typename }` before concluding `X` does
not exist.** `features` sat on the rejected list for two sweeps because of this,
and the earlier `variants { gfn { supportedFeatures } }` and
`variants { gfn { features } }` probes are on the record as 500s for the same
reason.

#### What `keywords` actually is, and why it is not this

`keywords` holds a stale run of lowercase markers — `rtx` on 89 titles,
`ray tracing` on 58, `path tracing` on 3, 92 in union. It looks like the answer
and is not: **Fortnite, Pragmata and Indiana Jones and the Great Circle are all
ray-traced and carry none of them**, and Fortnite carries only `nvidia reflex`.
It is marketing tagging, roughly half the real list, and it was shipped in one
build of this launcher before `variants.gfn.features` was found. Do not go back
to it.

`gfn { catalogSkuStrings { SKU_BASED_TAG } }` — the other field this document
listed as existing but untapped — is not it either: it holds the membership tier
as display text (`"Per i membri Premium"`, `null` for tier-free titles).

#### Not requested from the authenticated feed

`SEARCH_APPS` does not select `features`. The web client reads the same
`variant.gfn.features` off `apps.gxn.nvidia.com`, so it is very likely available
there too, but it is **unverified** and a wrong selection would fail the whole
authenticated catalog walk rather than just the flag. `refreshCatalog` already
walks the public feed a second time for details, so it takes the RTX index from
there instead — see `fetchPublicFacts`.

#### The two feeds do not always agree on variant ids

Matching the public index against an authenticated catalog **by variant id
alone loses titles**, because the same edition of the same game can carry a
different id on each side:

| Title | Public feed | Authenticated |
| --- | --- | --- |
| World of Warcraft®: Midnight | `102758611` | `103255961` |
| World of Warcraft® Classic | `100373211` | `104507916` |
| World of Warcraft®: Mists of Pandaria Classic™ | `102045211` | `104533074` |
| World of Warcraft® Burning Crusade Classic Anniversary Edition | `107139844` | `107140187` |

Every observed case is Battle.net. An id-only match returned 166 of 171 titles;
adding a fallback on lowercased `sortName` — an unlocalised slug both feeds emit
— brings it to **170**, and the last one (LEGO® Builder's Journey) is simply not
in the authenticated catalog at all, so there is nothing to badge. `sortName`
collides on 9 of the 5.889 entries, and each of those pairs is the same game
listed twice, so the fallback cannot badge an unrelated title. See `RtxIndex`
and `indexedRtx` in `catalog.ts`.

Worth remembering beyond RTX: **`cmsId` is not a stable cross-feed key.** The
details index gets away with matching on it because it is built and consumed
from the same public walk.

**`variants.storeUrl` and `variants.storeId` are real and useful.** `storeUrl`
is the store's own product page with NVIDIA's campaign parameters attached
(`https://store.steampowered.com/app/424370?utm_source=nvidia&utm_campaign=geforce_now`),
present on 6.879 of 6.902 variants and null for most UPLAY ones. `storeId` is
the store's internal id — a Steam appid, an Epic GUID — and has no consumer
here, so the walk asks for `storeUrl` alone.

**There are no supported-language fields.** Fifteen plausible names were tried
(`supportedLanguages`, `languages`, `localizations`, `audioLanguages`,
`subtitleLanguages`, `locales`, `interfaceLanguages`, the same under `gfn` and
under `variants`, …) and every one is a 500. Anything the UI wants to say about
languages would have to come from a store API, not from here.

**There is also no per-app query.** `apps` is the only root field: `app(cmsId:)`,
`cmsIds: […]`, `ids: […]` and `title:` are all 500, and introspection is off
(`__schema` 500, `__type` returns null, only `__typename` answers). So anything
a detail view shows has to be harvested during the bulk walk — which is why the
walk asks for `shortDescription` and `SCREENSHOTS` and the result is split into
two caches.

`shortDescription` and `longDescription` **are localised** by the request's
`language`: `it_IT` returns Italian prose. Coverage measured: 5.875 of 5.890
titles have a short description, 5.845 have screenshots (mean 9.7 each, 1920×1080).
Artwork sizes: `GAME_BOX_ART` 628×888, `HERO_IMAGE`/`TV_BANNER` 1920×1080,
`KEY_ART` 600×600.

`variants.supportedControls` is worth more than it looks on a TV: over the whole
catalog, 3.073 titles take a gamepad fully, 982 partially and **1.835 are
keyboard-and-mouse only**. `variants.subscriptions` carries `XBOX_GAME_PASS`,
`UBISOFT_PREMIUM`, `UBISOFT_CLASSIC`.

Two consequences for how it is used:

- **No search, no sort, no filter server-side.** This feed is all-or-nothing, so
  the launcher pages the lot, sorts it itself and caches it. That is the exact
  opposite of the rule for the authenticated API below, and the difference is
  the API's, not a change of mind.
- **Nothing here is user-relative, and two fields pretend otherwise.** Signed
  out, `gfn.playabilityState` is `UNPLAYABLE_DUE_TO_UPGRADE` for all 5.890
  entries — it is not requested for that reason. `minimumMembershipTierLabel`
  *is* a property of the title (`Premium` on 3.832 of them; null on free-to-play
  ones such as Counter-Strike 2, Warframe and Destiny 2) and is kept.

Ownership is the one thing this feed cannot give. That still needs the
authenticated API.

## GraphQL — catalog, library, ownership

**Endpoint:** `https://apps.gxn.nvidia.com/graphql?requestType=<type>`
(found 261 times in the client's HTTP cache)

**Authentication is by session cookie, not a bearer.**

This is the single most misleading thing about the API, and it cost several
debugging rounds. Observed on a live signed-in web session: **14 GraphQL calls,
none carrying an `Authorization` header.** The desktop client's `NV-Client-*`
headers are absent too — those belong to the native client, not the web one.

Consequences:

- Send the request from the authenticated partition (`session.fetch` with
  `credentials: 'include'`), not Node's `fetch`. The cookies are the credential.
- **Do not attach a bearer you found elsewhere.** The server honours the header
  over the cookie and then rejects it. A token lifted from
  `login.nvidia.com/userinfo` is valid at that endpoint and 401 here — which
  reads as "bad session" and sends you hunting for the wrong bug.

**Headers:**

```
Content-Type: application/json
Cookie: <from the signed-in partition>
```

**Use `application/json`, not `application/graphql`.** The bundle mentions the
latter, but the server rejects it — verified against the live endpoint:

| Content-Type | Result |
| --- | --- |
| `application/graphql` | `400` — `transport not supported` |
| `application/json` | reaches auth (`401`/`403`) |

`requestType` is a cache-partitioning hint, not a selector — the operation is in
the body. Observed values: `panels`, `userAccount`, `campaigns`, `appMetaData`,
`clientStrings`, `staticAppData`, `loginWallData`, `loginWallStrings`,
`overallGfnSupportedLanguages`.

**Everything requires a token.** There is no anonymous read path: unauthenticated
requests return `403 Forbidden`, and an empty bearer returns `401 Unauthorized`,
regardless of `NV-Client-*` headers, user agent, or `Origin`. The old public game
list (`static.nvidiagrid.net/supported-public-game-list/gfnpc.json`) now returns
`null`.

### `vpcId`

Most queries require a `vpcId`: the **server zone** identifier, not an account id.
The client resolves a recommended zone (cloudmatch, `prod.cloudmatchbeta.nvidiagrid.net`)
and caches it as the default zone. A `GetAppDataQueryForCmsIdWithoutVpcId` variant
exists, so some queries tolerate its absence.

### Browse and search the catalog

Search and filtering are **server-side**, with cursor pagination. Do not fetch the
whole catalog and filter locally.

```graphql
query GetSearchFilterResults(
  $vpcId: String!, $locale: String!, $sortString: String!,
  $fetchCount: Int!, $cursor: String!, $searchString: String!,
  $filters: AppFilterFields!) {
  apps(vpcId: $vpcId, language: $locale, orderBy: $sortString,
       first: $fetchCount, after: $cursor,
       searchQuery: $searchString, filters: $filters) {
    numberReturned
    numberSupported
    pageInfo { hasNextPage endCursor totalCount }
    items {
      id
      title
      images { TV_BANNER HERO_IMAGE }
      variants {
        id
        appStore
        supportedControls
        gfn {
          status
          library { status selected playStatus }
        }
      }
      gfn {
        playabilityState
        minimumMembershipTierLabel
        catalogSkuStrings { SKU_BASED_TAG }
      }
    }
  }
}
```

Omit `$searchString` for a plain browse — a second overload of the same operation
name exists without it.

### The library filter

"My library" is a filter on the same `apps` query, not a separate endpoint:

```json
{ "variants": { "gfn": { "library": { "status": { "notEquals": "NOT_OWNED" } } } } }
```

`AppFilterFields` mirrors the app schema and takes comparison operators
(`notEquals` confirmed). Library status values seen: `NOT_OWNED`, `AVAILABLE`,
`PLAYABLE`, `LIBRARY_NOT_FOUND`.

`GetAppsPatchInfoWithLibraryFilter` uses the same filter to poll patch/maintenance
state for owned titles.

### Game detail

`GetAppDataQueryForCmsId($vpcId, $locale, $cmsIds: [Int]!)` — note `[Int]`, so
cmsIds are numeric. Returns box art (`GAME_BOX_ART`, `HERO_IMAGE`, `KEY_ART`,
`TV_BANNER`, `SCREENSHOTS`), `publisherName`, `developerName`, `genres`,
`sortName`, descriptions, per-variant `storeUrl`, `shortName`, `subscriptions`,
and `marqueeScrimPrimaryRGB` (the accent colour GFN itself uses behind the hero).

### Linked stores and sync state

```graphql
query GetUserAccountLinkingData {
  userAccount {
    subscriptions { id }
    storesData {
      store
      accountLinkingData {
        userDisplayName
        expiresIn
        userIdentifier
        accountSyncingData { totalNumberOfSyncedGfnGames syncState syncDate }
      }
    }
  }
}
```

### Marking a title as owned

This is the answer to "can the launcher add owned games itself?" — **yes**:

```graphql
mutation AddOwnedVariant($cmsId: String!, $locale: String!) {
  addOwnedVariant(language: $locale, variantId: $cmsId) { app { id } }
}
```

`RemoveOwnedVariant` and `SelectOwnedVariant` (pick which store variant to launch)
have the same shape. Note `variantId` is the **variant** id, i.e. the cmsId of a
specific store's edition — the same value the launch deep link takes.

All three are wired in `src/main/gfn/library.ts` and **all three are transcribed
from the bundle**, which holds them as literals in one operation table. This
entry used to call the latter two inferred; they are not, and
`SelectOwnedVariant` is character-for-character the document below. The client
reaches it through `addPlatformPreference(variantId)` →
`lcarsService.selectOwnedVariant`, called both when the user changes store from
the game details page and, via `persistPlatformSelection`, when its own flow
resolves an unambiguous one.

What is still unobserved is a *successful response* to either from this
launcher. `SelectOwnedVariant`'s name says *owned*, so it may well refuse a
variant the account has not been marked as owning — the client only ever calls
it after ownership is established. The panel therefore offers "mark owned" (X)
beside "set launch store" (A), and `src/main/ipc.ts` patches the local catalog
**only after the server accepts** — a locally-recorded choice GFN never took
would vanish at the next refresh with nothing to explain why.

Worth knowing what that selection is and is not worth: it is the `selected` flag
this launcher reads in `pickLaunchVariant`, and it is *not* readable on the deep
link's own resolution path — see the `shortName` section above. Setting it fixes
which edition the launcher hands over; it is the `shortName` that makes the
client accept it.

The `requestType=appMetaData` these are sent under is also a guess: the observed
list of request types never ties one to a mutation.

Normal operation is still *link once, sync many*: link a store, GFN pulls the whole
library, and new catalog titles the user already owns appear on their own. These
mutations are the manual override, not the main path.

## ALS — Account Linking Service

A separate REST service from the GraphQL API. Base URL comes from the client's
runtime `appConfig.accountLinking`, and a proxy override can replace it, so it
cannot be hardcoded.

**The `appConfig` is a file on disk, not something that has to be intercepted.**
The web app the client hosts ships it inside the Flatpak:

```
<installPath>/files/mall/shared/assets/config/config.json
```

Its `accountLinking` block, on client 2.0.87.130:

```json
{ "server": "https://als.geforcenow.com", "clientId": "gfn-pc",
  "defaultSyncWaitInterval": 10000, "redirectFinishedUrl": "https://static-als.nvidia.com/result" }
```

`src/main/gfn/appConfig.ts` reads it from there, which keeps the URL
configuration rather than a constant while needing no request to observe. Same
file also carries `lcars.serverUrl` (the GraphQL endpoint, confirming
`apps.gxn.nvidia.com/graphql`), `starfleet.url`, `cms.server` and
`jarvis.clientId` — it is the single best place to look before guessing at any
GFN host.

**The path is `/v1/`, not `/v2/`.** The bundle builds every ALS URL with
`buildApiUrl(path) => appConfig.accountLinking.server + "/v1/" + path`. The
`/v2/` recorded here previously was transcribed from an older note and never
observed against a live service.

```
POST {serverUrl}/v1/token            -> JWT (guest-mode nonce exchange only)
POST {serverUrl}/v1/sync/{provider}  -> 202 Accepted, sync completes async
DELETE {serverUrl}/v1/linking/{provider}
```

Operations present: `GetApps`, `GetOAuthURL`, `LinkAccount`, `UnlinkAccount`,
`LibrarySync`. `POST /v1/sync/{provider}` is what GFN's own "Refresh library"
button calls. The sync response carries `numberOfSyncedGames`, `appStoreName`,
`persona`.

**Not every linked store can be synced, and asking anyway is a 400.** Linking
and syncing are separate capabilities. The client filters on them before it
calls:

```js
// OwnershipSyncService
getSyncRequests(stores, …) { … if (provider && provider.isAccountSyncSupported) { … postRequestToSync(…) } }
// AccountProvider
get isAccountSyncingSupported() {
  return this.digitalStoreInfo.features
    .filter(f => f.__typename === 'AccountGamesSyncing')
    .some(f => f.supported === true)
}
```

That metadata comes from `appStoreDefinitions` — a slice of the client's
`GetStaticAppData`, under `requestType=staticAppData`:

```graphql
appStoreDefinitions(language: $locale) {
  store
  features {
    __typename
    ... on AccountLinkingSso     { displayProposition supported }
    ... on AccountGamesSyncing   { displayProposition supported }
    ... on AccountSubscriptions  { displayProposition }
  }
  accountLinkingMetadata { supportedVariantIds isSupported isRequired label }
}
```

`APP_STORE_FEATURES` in `queries.ts` asks for the narrowed form and
`readSyncableStores` in `library.ts` turns it into the `canSync` flag on
`LinkedProvider`. Measured on a live account: EPIC links but does not sync, and
`POST /v1/sync/EPIC` answers **400** — which is the mechanical reason Epic games
have to be marked owned by hand. A store missing from the answer is treated as
syncable, so a schema change costs a refused request rather than a store that
silently stops syncing.

**Auth is `Bearer <Starfleet id token>`, and the cookies are not enough.** This
was an open question for two releases and the answer, once measured, was that
the bet had lost: sending no `Authorization` and relying on the partition's
`.geforcenow.com` cookies produced `Sync refused (401)` for every store, every
time.

The chain in the bundle (client 2.0.87.130) is explicit:

```js
// AlsService
createHeader(g)         { return { authorization: `Bearer ${g.token}` } }
providerSync(g,E,D)     { … this.alsEndpoint.post(this.buildApiUrl("sync/").concat(g), T) … 202 === k?.status }
postRequestToSync(g,E,D){ return this.idmService.getAuthToken(D,E).pipe(switchMap(T => this.providerSync(g,T,E))) }
// IdmService
getAuthToken(b,V)       { return this.starfleetService.getAuthToken(b,V).pipe(map(t => ({ token: t }))) }
// StarfleetService
getAuthToken(d,w)       { … .pipe(map(session => session.data.idToken)) }
```

So it is the Starfleet **id** token, not the access token, and not the GFNJWT.
The same bundle has three other `createHeader` implementations that build
`GFNJWT <token>` — LCARS, the Starfleet KV store, and GXT remote config. Which
scheme goes to which service is the whole distinction, and getting it wrong
reads as a 401 either way.

**Where that token is, and how the launcher gets it.** Starfleet persists its
session under `DBName="starfleet"`, `DBKey="starfleetSession"`, in one of two
backends: `sharedStorage` for the native client, **IndexedDB** for the web build.
The stored record is

```json
{ "authProvider": "starfleet", "data": "<btoa(encodeURIComponent(JSON.stringify(session)))>" }
```

and the decoded session is
`{ clientToken, accessToken, idToken, user, clientTokenExpiry, accessTokenExpiry, idTokenExpiry }`.

The launcher already hosts that web app on `persist:gfn-session`, and IndexedDB
is per-origin, so `webAuth.ts` reads the record out of the capture window at the
end of a successful capture and keeps `idToken` — only `idToken` — in memory.
This is **not** one of the dead ends below: nothing is read out of the desktop
client's profile, no OAuth client is borrowed, and none is registered. It is the
same act as the header interception that already happens, against a different
store in the same window.

`readIdToken` in `webAuth.ts` is the pure half and is tested; `getAlsToken` in
`session.ts` withholds the token once its `exp` has passed, so a stale one is
recognised before ALS has to say so. On a 401 anyway — the token can be revoked
server-side with no other sign — `ipc.ts` invalidates the session, re-captures
**once**, and retries. Once, because a headless capture boots the whole web app.

`als.ts` still filters `Authorization` out of the replayed capture headers: that
one is the GFNJWT scoped to `apps.gxn.nvidia.com`, and forwarding it repeats the
mistake recorded under *Authentication* below — a server honours the header over
the cookie and *then* rejects it. The Bearer is put back afterwards, from
`config.token`, so the built header wins over the captured one.

## Authentication

`Authorization: Bearer <access_token>`, from an **OAuth 2.0 Authorization Code
flow with PKCE** against NVIDIA accounts. The bundle generates a 32-byte verifier
via `crypto.getRandomValues`, matching RFC 7636 S256.

NVIDIA publishes standard OIDC discovery, which returns 200:

```
https://login.nvidia.com/.well-known/openid-configuration
  authorization_endpoint: https://login.nvidia.com/authorize
  token_endpoint:         https://login.nvidia.com/token
```

Tokens observed in the client profile are `ES256`, `iss=https://login.nvidia.com`.

### Reusing the desktop client's token does not work

Investigated and ruled out. The evidence:

- **The live token is only in memory.** The running client holds it; nothing
  writes it to a durable store.
- **The only on-disk copies are incidental.** Access tokens appear inside the
  service worker's CacheStorage, because workbox cached the *request*, headers
  included:
  `Default/Service Worker/CacheStorage/<sw>/<cache>/…`
- **They expire in about a day.** The copy found on 2026-08-15 had already
  expired on 2026-08-14.
- **There is no refresh token.** Zero occurrences anywhere in the profile, so a
  scraped access token cannot be renewed.
- **Nothing is in the keyring.** The Flatpak holds `org.freedesktop.secrets=talk`,
  but no GFN or Chromium-safe-storage entry exists.

Scraping would therefore give a dead token that cannot be refreshed, and would
break on any change to GFN's caching. `src/main/gfn/auth.ts` implements the OAuth
flow instead.

### Reusing GFN's own OAuth client does not work either

Also tested and ruled out, on two independent grounds.

**The authorization server rejects a loopback redirect.** Probing `/authorize`
with GFN's client id (taken from the `aud` claim on its tokens) and
`http://127.0.0.1:41234/callback`:

```
HTTP 400 — "invalid redirect_uri", error=invalid_request
```

Native-app loopback is not registered for that client, so the callback can never
be received. Its registered redirect belongs to NVIDIA, so it is unusable by a
third party by construction.

**It is a confidential client.** `libGeronimo.so` contains
`client_id=%s&client_secret=%s&refresh_token=%s&grant_type=refresh_token` — the
refresh path requires a **client secret** embedded in NVIDIA's binary. Even had
the redirect been accepted, renewing a token would mean extracting and shipping
a credential that is deliberately not public.

### Registering our own client looks unavailable too

The discovery document rules out the client shape a desktop launcher needs:

- **No `registration_endpoint`** — no dynamic client registration (RFC 7591).
- **`token_endpoint_auth_methods_supported: ["client_secret_basic","client_secret_post"]`**
  — `none` is absent, so the server does not support public/native clients at
  all. Every client must authenticate with a secret, which a distributed desktop
  app cannot hold safely.
- `code_challenge_methods_supported` is not advertised, though the GFN client
  clearly uses PKCE.

No self-service registration portal for third-party apps could be confirmed.
Do not write a registration walkthrough into this repo unless one is verified.

### What the launcher does instead: host the login itself

Implemented in `src/main/gfn/webAuth.ts`.

The launcher opens NVIDIA's real web client (`https://play.geforcenow.com/`)
inside an Electron `BrowserWindow` on a partition it owns
(`persist:gfn-session`). Authentication happens through NVIDIA's own flow with
its own client and registered redirect — nothing is impersonated and no secret
is extracted — and credentials are read from requests made by a window the
launcher owns, not from another application's private store.

Verified: the page loads in that partition and lands on
`play.geforcenow.com/mall/#/loginwall`.

What interception actually yields: the **endpoint**, the safe **headers**, and
the **vpcId**. Not a bearer — see above, there isn't one.

One credential does not travel on any request we can watch, and is read out of
the window's storage instead: the **Starfleet id token**, which ALS needs and
which the web app only sends when the user links, unlinks or syncs a store. It
comes from the page's own IndexedDB at the end of the capture — see *ALS* above
for the record's shape and for why this is not the rejected "read the desktop
client's on-disk token" route.

The vpcId arrives in the query string, since the web client issues GraphQL over
GET (`withBody=0`, `parsed=10` on a real session), so both the POST body and the
URL are checked.

Two traps worth keeping in mind, both of which produced real failures:

- **Do not settle for the first credential in sight.** Accepting any
  authenticated request completed the capture within seconds and destroyed the
  window *before* the app loaded its catalog — so no GraphQL call ever happened,
  which then looked like proof that none existed. Waiting for a genuine
  `/graphql` call is what keeps the window alive long enough to produce one.
- **Do not replay every captured header.** The fetch spec forbids scripts from
  setting `Origin`, `Referer`, `Cookie` and anything `Sec-*`; Chromium answers
  with `net::ERR_FAILED` rather than ignoring them.

Expiry is handled by the same mechanism. Tokens live about a day; the persisted
partition means a later headless capture needs no interaction, because the
hosted app signs itself back in and we read the fresh token off its next
request. `ensureSession` does this, gated on the persisted `gfnLinked` flag.

**That gate matters.** A headless capture boots the whole GFN web app and can
sit for its full timeout, so it must never run speculatively — on a launcher
that has never been signed in there is nothing to revive, and the wait stalls
whatever asked for it. The same reasoning keeps provider listing off the
renderer's first-paint path.

Trade-offs, stated plainly:

- It is an embedded-browser flow, which providers generally discourage.
- It breaks whenever GFN changes its web app.
- **Sign-in is not gamepad-navigable.** NVIDIA's login page expects a pointer
  and keyboard, so the one-time sign-in is the single place this launcher
  cannot be driven from the couch.

### Observing the live handshake

If the flow needs to be watched, start the client with CDP — the wrapper drops
argv, so the same bypass applies:

```bash
flatpak run --command=/app/cef/GeForceNOW --cwd=/app/cef com.nvidia.geforcenow \
  --remote-debugging-port=9222
# then attach to http://127.0.0.1:9222/json/list
```

The Flatpak has `shared=network`, so the port is reachable from the host.
**Never write a captured token to disk or into this repository.**

## Other observed endpoints

| Purpose | Host |
| --- | --- |
| Session / zone matching | `prod.cloudmatchbeta.nvidiagrid.net` |
| Cloud variables | `api.gdn.nvidia.com/cloudvariables/v3` |
| Telemetry | `events.telemetry.data.nvidia.com`, `telemetry.gfe.nvidia.com` |
| Tracing | `prod.otel.kaizen.nvidia.com` |

## Server status — Atlassian Statuspage

`status.geforcenow.com` is a **stock hosted Atlassian Statuspage**, page id
`2bdwmtrb0hg9`. Response headers give it away: `x-statuspage-version`,
`server: AtlassianEdge`, assets from `dka575ofm4ao0.cloudfront.net`, incident
shortlinks on `stspg.io`.

Every documented Statuspage endpoint answers 200:

```
/api/v2/summary.json                        ← the only one the launcher uses
/api/v2/status.json      /api/v2/components.json
/api/v2/incidents.json   /api/v2/incidents/unresolved.json
/api/v2/scheduled-maintenances{,/active,/upcoming}.json
/history.rss  /history.atom  /index.json
```

**No auth, no API key, no `User-Agent`.** A bare `curl -H 'User-Agent:'` returns
the full body — unlike the game list, which drops the connection without one.
`access-control-allow-origin: *`, `cache-control: max-age=10,
stale-while-revalidate=20`, and **`If-None-Match` works** (verified 304).

`summary.json` is ~41 KB and carries page, status, components, incidents and
maintenances together, so `src/main/status/statuspage.ts` fetches only that one.

### Component tree — four traps

`components` is a **flat array of 113**: 1 ungrouped global component
("NVIDIA Global Services"), 36 groups, 76 leaves. A group has `group: true` and
a `components: [ids]` array; a leaf has a `group_id` back-pointer.

1. **The array is not in tree order.** Index 0 is the global component, then
   every group's `position: 1` leaf, then the rest. Build from `group_id`.
2. **`position` is scoped per level** — 1..37 across the top, 1..N inside each
   group — so it cannot reconstruct nesting either.
3. **Leaf names are not unique.** "Cloud Storage" appears twenty times, once per
   region. Key on `id`.
4. **Group names have four different shapes**, all of which occur:
   `Germany [RTX 5080]`, `Poland [RTX-5080]` (hyphen), `France 2` (no suffix),
   `KR GFN1  - Alliance Partner` (double space). `splitGroupName` handles all
   four; there is a unit test per shape.

Twelve of the 36 groups are `… - Alliance Partner`: partner-operated and offered
only in that partner's territory.

Component `status`: `operational | degraded_performance | partial_outage |
major_outage | under_maintenance`. Page `status.indicator`: `none | minor |
major | critical | maintenance`. `status.description` is free text NVIDIA edits,
so drive UI off `indicator` and show `description` as the label.

### Incidents mostly have nothing to do with datacenters

Of 50 historical incidents, **41 carry `impact: 'none'` and `components: []`** —
they are about a single game, not a region. Filtering the list to "affects my
region" would show nothing almost all of the time, so the launcher lists open
incidents globally and only *marks* the region-scoped ones.

`incident_updates` is **newest-first**. `incident.components[]` arrives as full
component objects, so mapping an incident to its regions needs no second lookup.
`affected_components` inside an update is `null` unless the update itself
changed a component, and its `name` is `"<Group> - <Leaf>"`.

Scheduled maintenance is the incident shape plus `scheduled_for` /
`scheduled_until`; only four exist in all of history.

## Which datacenter the client is set to

**`~/.var/app/com.nvidia.geforcenow/.local/state/NVIDIA/GeForceNOW/sharedstorage.json`**

The Flatpak manifest declares `persistent=.local/state` and unsets
`XDG_STATE_HOME`, so the container's state directory is bound there — the path
is stable, not incidental. Read by `src/main/status/zone.ts`.

> ⚠️ **This file holds a live `accessToken`, a `clientToken`, an `idToken` JWT
> carrying the user's email, their `userId`/`externalUserId`, and the machine's
> MAC address, LAN IP and router MAC.** `parseZoneAssignment` reads three
> subtrees and returns six declared fields; the parsed root is never logged and
> never crosses the bridge. `zone.test.ts` asserts the output keys against a
> fixture that includes a session blob. Never `console.log` the object.

Three keys matter:

```json
"networkConfig": {
  "currentFingerPrint": "c847d04d…",
  "routingOverride": {
    "address": "eu-germany.cloudmatchbeta.nvidiagrid.net",
    "name": "Germany",
    "defaultZone": "prod.cloudmatchbeta.nvidiagrid.net"
  },
  "networks": {
    "c847d04d…":                     { "zonesLatencies": { "latency@eu-germany.cloudmatchbeta.nvidiagrid.net": "12" } },
    "c847d04d…_eu-germany.cloud…":   { "networkTestReturn": { "testResult": { "zoneName": "NP-FRK-06", "latency": 12 } } }
  }
},
"remoteOverrides": { "metaData": { "regionName": "eu-germany", "zoneName": "NP-FRK-08" } }
```

- **`routingOverride` present ⇔ the user pinned a region; absent ⇔ Auto.** Not
  inferred — it is what NVIDIA's own code does. `selectAuto()` in
  `server-location-info.service.ts` runs
  `delete modifiedNetworkConfig.routingOverride`.
- **`metaData.zoneName` is the exact Statuspage leaf name**, modulo the tier
  suffix: the client says `NP-FRK-08`, the status page calls that component
  `NP-FRK-08 [RTX 5080]`. This is the same value the launcher captures as
  `vpcId` (see above), which makes the match exact string work rather than a
  name-normalisation guess.
- **`zonesLatencies` must be read through `currentFingerPrint`.** `networks`
  holds two entries per fingerprint; the bare one has the latency table, the
  `<fp>_<host>` sibling has a single test result. Taking the first key is wrong
  about half the time. Values are strings — and `Number(null)` is `0`, so guard
  before casting or a missing measurement renders as an excellent `0 ms`.

Re-pinning does not clear `metaData`, so compare the pin's slug
(`routingOverride.address.split('.')[0]`) against `metaData.regionName`: if they
disagree, `zoneName` describes the region the user just left.

**The file is rewritten for reasons that have nothing to do with routing** —
`starfleetSession` rotating, `gfnTelemetry` counters, `userConsentInfo` — several
times an hour while the client runs. Anything watching it must therefore compare
the *resolved* zone and not the mtime, or it will report a datacenter change on
every token refresh. That comparison is `sameZone` in `src/main/status/zone.ts`;
`src/main/clientWatch.ts` is what calls it.

### The deploy layout, and why an install path expires

`flatpak info --show-location com.nvidia.geforcenow` answers with the **commit
directory**, not a stable path:

```
~/.local/share/flatpak/app/com.nvidia.geforcenow/
  current -> x86_64/master
  x86_64/master/active -> a6efb689…                 # 64-hex commit, one dir per deploy
  x86_64/master/a6efb689…/files/mall/…              # what --show-location prints
```

An update deploys a new commit directory and **prunes the old one**, so a
remembered `installPath` is not merely out of date — it is an ENOENT. That is
what makes memoising anything read out of it (`appConfig.ts`) a trap.

It is also the signal. `stat` follows symlinks, so statting
`<root>/app/com.nvidia.geforcenow/current/active` returns the *deployed commit's*
inode and the repoint arrives as an ordinary change; `current` keeps the path
free of the architecture and the branch. Verified with `fs.watchFile` from inside
the launcher's own Flatpak, where `HOME` is the real home and both installation
roots — `~/.local/share/flatpak` and `/var/lib/flatpak` — are readable under the
grants the manifest already carries. `~/.local/share/flatpak/.changed` is flatpak's
own change-notify file and would be one target instead of two, but the grant is
the *app subdirectory*, so it is not visible from the sandbox.

### NVIDIA ships unminified TypeScript in sourcemaps

`<installPath>/files/mall/*.js.map` contains the real sources —
`server-location-info.service.ts`, `network-configuration.service.ts`,
`server-routing/NetworkConfiguration.ts`. **Read these before reverse-engineering
the bundle.** They are how the `routingOverride` semantics above were confirmed
rather than guessed.

### `prod/v2/serverInfo` — investigated, deliberately unused

`GET https://prod.cloudmatchbeta.nvidiagrid.net/v2/serverInfo` → 200,
unauthenticated, no `User-Agent` needed. The base URL is `grid.server` in the
same Flatpak `config.json` that `appConfig.ts` reads for `accountLinking.server`.
Its `metaData` array carries `{"key": "local-region", "value": "Germany"}` — the
region Auto geo-routes this network to — and `{"key": "gfn-regions", "value":
"Northern California (USA),…,Japan"}` plus one `"<Region>" → "https://<slug>…"`
entry per region, i.e. a live slug⇄display-name map. All 24 names map 1:1 onto
Statuspage groups after suffix stripping (verified, zero misses); the 12 partner
groups are absent from `gfn-regions`.

It is **not** on the launcher's path. `zoneName` already resolves the region
exactly and offline, so this would only earn a request when there is no
`zoneName` at all — GFN installed but never streamed — and in that case the
honest answer is "start a game once" rather than a region guess. Recorded here
in case that judgement needs revisiting.

## Runtime logs

**The host-side path is not the client's log.**
`~/.local/state/NVIDIA/GeForceNOW/` holds only the wrapper's `gfn-launcher.log`,
window geometry in `storage.json`, and `assets/`. The client's own logs live
inside the Flatpak sandbox:

```
~/.var/app/com.nvidia.geforcenow/.local/state/NVIDIA/GeForceNOW/GeForceNOW.log   # wrapper
~/.var/app/com.nvidia.geforcenow/.local/state/NVIDIA/GeForceNOW/console.log      # the Angular app
~/.var/app/com.nvidia.geforcenow/.local/state/NVIDIA/GeForceNOW/debug.log        # CEF
```

Fastest way to confirm a deep link was received. `console.log` is megabyte-scale
and **contains tokens** — grep it, do not paste it.
