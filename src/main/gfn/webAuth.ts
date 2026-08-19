import { BrowserWindow } from 'electron'
import { POINTER_PRELOAD, registerPointerTarget } from '../pointer'
import { DEFAULT_GRAPHQL_ENDPOINT } from './graphql'
import { getAuthSession } from './partition'

export { getAuthSession }

/**
 * Obtains a GFN session by hosting NVIDIA's own web client in a window we own.
 *
 * Why this shape:
 *  - NVIDIA's authorization server has no dynamic registration and does not
 *    advertise `none` for token endpoint auth, so a public/native OAuth client
 *    — the kind a desktop launcher needs — cannot be registered.
 *  - GFN's own client rejects a loopback redirect (400 invalid redirect_uri)
 *    and is confidential, so it cannot be borrowed either.
 *  - The desktop client's on-disk tokens are expired leftovers with no refresh
 *    token.
 *
 * So the user signs in through NVIDIA's real flow, in a window on a partition
 * this app owns, and we read the credentials out of the requests that window
 * makes. Nothing is impersonated and no secret is extracted.
 *
 * The same interception also yields `vpcId` and the `NV-Client-*` headers,
 * which is better than guessing them: they come from a request GFN itself
 * considered valid.
 *
 * See docs/gfn-api.md for the evidence behind each of those dead ends.
 */

const GFN_WEB_URL = 'https://play.geforcenow.com/'

/**
 * Everything, not a host allowlist.
 *
 * The first attempt filtered on `https://*.nvidia.com/*` and never fired: the
 * web client is served from play.geforcenow.com and its API traffic need not
 * sit under nvidia.com. Only this app's own partition flows through here, so
 * watching every request costs nothing and removes a guess that was wrong once
 * already.
 */
const ALL_URLS = { urls: ['*://*/*'] }

/**
 * How long to keep waiting for a `vpcId` once a token is in hand.
 *
 * Token and vpcId do not necessarily arrive on the same request — plenty of
 * operations (`GetUserAccountLinkingData`, `clientStrings`) send no vpcId at
 * all — so requiring both from one request was the second reason capture
 * stalled. Wait a little for the pair, then take what we have.
 */
const VPC_GRACE_MS = 10_000

/**
 * Whether a request is a call to the API we are going to reuse the token on.
 *
 * Nothing but a GraphQL call will do. A GFN session authenticates against
 * several services — telemetry, OpenTelemetry, `gx-target-*` experiments and
 * NVIDIA's OIDC `userinfo` — each with its own bearer. Accepting "any API host"
 * as a fallback picked `login.nvidia.com/userinfo`, an identity credential that
 * is perfectly valid there and 401 everywhere else.
 *
 * That fallback also masked the real problem. Settling for the first token in
 * sight finished the capture and tore the window down within seconds, before
 * the web app had loaded the catalog — so no GraphQL call ever happened, which
 * looked like evidence that none existed. Waiting for a genuine one both gets
 * the right credential and keeps the window alive long enough to produce it.
 *
 * Method is not checked: GraphQL over GET is legitimate, and the vpcId is read
 * from the query string in that case.
 */
export function isApiRequest(rawUrl: string): boolean {
  try {
    return new URL(rawUrl).pathname.includes('/graphql')
  } catch {
    return false
  }
}

export interface CapturedSession {
  /**
   * Null is normal.
   *
   * The web client authenticates its GraphQL calls with **session cookies**,
   * not a bearer — 14 observed calls carried no Authorization header at all.
   * Requiring one was why capture kept failing, and sending a bearer lifted
   * from some other service was why the ones that "succeeded" got 401: the
   * server honours the header over the cookie and then rejects it.
   */
  token: string | null
  /**
   * The Starfleet id token — **ALS's** credential, not GraphQL's.
   *
   * The two are not interchangeable, which is the whole reason this field is
   * separate from `token`. The shipped client sends `Bearer <id token>` to ALS
   * (`AlsService.providerSync` -> `createHeader` -> `IdmService.getAuthToken`
   * -> `StarfleetService.getAuthToken` -> `session.data.idToken`) and
   * `GFNJWT <token>` to LCARS, the KV store and GXT. Sending either one to the
   * other service is a 401.
   *
   * It is not on any request we can watch — the web app only calls ALS when the
   * user links, unlinks or syncs a store — so it is read out of the page's own
   * IndexedDB instead. Null when that read fails, which costs library sync and
   * nothing else.
   */
  idToken: string | null
  clientId: string
  clientVersion: string
  vpcId: string
  endpoint: string
  /**
   * Every header the winning request carried, minus the ones a new request
   * must compute for itself.
   *
   * Replaying the lot beats cherry-picking: the first attempt sent only the
   * bearer and the two NV-Client-* headers and was rejected 401, and guessing
   * which of the rest mattered would have been another round of trial and
   * error.
   */
  headers: Record<string, string>
}

/**
 * Headers a new request must not carry over.
 *
 * Beyond the obvious per-request ones, the fetch spec forbids scripts from
 * setting `Origin`, `Referer`, `Cookie` and anything `Sec-*`. Replaying them
 * verbatim did not merely get ignored — Chromium refused the request outright
 * with `net::ERR_FAILED`.
 */
const DROPPED_HEADERS = new Set([
  'host',
  'content-length',
  'content-type',
  'accept-encoding',
  'connection',
  'origin',
  'referer',
  'cookie',
  'dnt',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'via'
])

function isForbiddenHeader(name: string): boolean {
  const lower = name.toLowerCase()
  return DROPPED_HEADERS.has(lower) || lower.startsWith('sec-') || lower.startsWith('proxy-')
}

export function collectHeaders(
  raw: Record<string, string | string[] | undefined>
): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (isForbiddenHeader(key)) continue
    const single = Array.isArray(value) ? value[0] : value
    if (single !== undefined) headers[key] = single
  }
  return headers
}

export interface CaptureOptions {
  /**
   * Show the window so the user can sign in. Run headless once a partition
   * already holds a valid login — then this is just a token top-up.
   */
  interactive: boolean
  timeoutMs?: number
}

/** Drops the persisted login. The next capture will need the user again. */
export async function clearAuthSession(): Promise<void> {
  const ses = getAuthSession()
  await ses.clearStorageData()
  await ses.clearCache()
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string | null {
  const lower = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== lower) continue
    const found = Array.isArray(value) ? value[0] : value
    return found ?? null
  }
  return null
}

/**
 * Pulls a `vpcId` out of a GraphQL POST body.
 *
 * Two shapes are handled because the client is not consistent: a JSON envelope
 * with a `variables` object, and a raw GraphQL document with the value inlined
 * (which is what `Content-Type: application/graphql` implies). Only looking for
 * the first missed every request on a real session.
 *
 * Bodies backed by a blob or file rather than bytes cannot be read here; those
 * simply yield nothing, which the caller tolerates.
 */
export function readVpcId(uploadData: Electron.UploadData[] | undefined): string | null {
  for (const part of uploadData ?? []) {
    if (!part.bytes) continue
    const text = part.bytes.toString('utf8')

    try {
      const parsed = JSON.parse(text) as { variables?: { vpcId?: unknown } }
      const vpcId = parsed.variables?.vpcId
      if (typeof vpcId === 'string' && vpcId.length > 0) return vpcId
    } catch {
      // Not JSON — fall through to the raw-document form.
    }

    const inline = /["']?vpcId["']?\s*:\s*["']([^"']+)["']/.exec(text)
    if (inline?.[1]) return inline[1]
  }
  return null
}

/** Reads a `vpcId` out of a GraphQL GET query string. */
export function readVpcIdFromUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl)
    const direct = url.searchParams.get('vpcId')
    if (direct) return direct

    const variables = url.searchParams.get('variables')
    if (variables) {
      const parsed = JSON.parse(variables) as { vpcId?: unknown }
      if (typeof parsed.vpcId === 'string' && parsed.vpcId.length > 0) return parsed.vpcId
    }
  } catch {
    // Not a URL, or variables that are not JSON.
  }
  return null
}

/**
 * Where the web client keeps its Starfleet session.
 *
 * The bundle declares `DBName="starfleet"`, `DBKey="starfleetSession"` and two
 * storage backends — `sharedStorage` and IndexedDB — writing the same encoded
 * record either way: `{ authProvider: "starfleet", data }`, where `data` is
 * `btoa(encodeURIComponent(JSON.stringify(session)))`.
 *
 * **The scan goes by key, not by name.** Both the database name and the object
 * store name are assembled at runtime from the app's own config, and a probe
 * looking for a store called `starfleet` found three databases and no such
 * store on a real profile — the record was there, under another name. The key
 * is the one part the bundle states outright, so that is what is searched for.
 */
const STARFLEET_PROVIDER = 'starfleet'
const STARFLEET_KEY = 'starfleetSession'

/**
 * How long to keep asking the page for its Starfleet session.
 *
 * Capture finishes as soon as an authenticated GraphQL call is seen, and on a
 * warm service worker that can be a second and a half after `loadURL` — early
 * enough that the document may still be the initial empty one, whose opaque
 * origin has no IndexedDB. So the probe is retried rather than trusted once,
 * and the budget caps how long a page that never settles can hold the capture.
 */
const STARFLEET_READ_MS = 6_000
const STARFLEET_RETRY_MS = 400

const READ_STARFLEET_SESSION = `(async () => {
  const out = { record: null, databases: 0, stores: 0, error: null }
  const open = (name) =>
    new Promise((resolve) => {
      let request
      try {
        // No version argument: this must never trigger an upgrade transaction
        // on a database the app itself owns.
        request = indexedDB.open(name)
      } catch {
        resolve(null)
        return
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(null)
      request.onblocked = () => resolve(null)
    })
  const read = (db, store) =>
    new Promise((resolve) => {
      try {
        const request = db.transaction(store).objectStore(store).get(${JSON.stringify(STARFLEET_KEY)})
        request.onsuccess = () => resolve(request.result ?? null)
        request.onerror = () => resolve(null)
      } catch {
        resolve(null)
      }
    })
  try {
    const names = (await indexedDB.databases()).map((entry) => entry.name).filter(Boolean)
    out.databases = names.length
    for (const name of names) {
      const db = await open(name)
      if (!db) continue
      // objectStoreNames is a DOMStringList: array-like, and deliberately not
      // spread — it has no Symbol.iterator, and the TypeError that produced was
      // indistinguishable from "no session here".
      const stores = Array.from(db.objectStoreNames)
      out.stores += stores.length
      for (const store of stores) {
        const record = await read(db, store)
        if (record) {
          out.record = record
          break
        }
      }
      db.close()
      if (out.record) break
    }
  } catch (error) {
    out.error = String((error && error.message) || error)
  }
  return out
})()`

interface StarfleetProbe {
  record?: unknown
  databases?: number
  stores?: number
  error?: string | null
}

/**
 * Pulls the id token out of a stored Starfleet session, and nothing else.
 *
 * The record also holds an access token, a client token and the signed-in
 * user's identity. None of that has any business leaving this function: the
 * launcher needs exactly one field, so exactly one field comes back.
 *
 * Every malformed shape yields null rather than throwing — this runs inside a
 * capture that must still succeed without it.
 */
export function readIdToken(record: unknown): string | null {
  if (typeof record !== 'object' || record === null) return null
  const { authProvider, data } = record as { authProvider?: unknown; data?: unknown }
  if (authProvider !== STARFLEET_PROVIDER || typeof data !== 'string') return null

  try {
    const session = JSON.parse(
      decodeURIComponent(Buffer.from(data, 'base64').toString('utf8'))
    ) as { idToken?: unknown }
    return typeof session.idToken === 'string' && session.idToken.length > 0
      ? session.idToken
      : null
  } catch {
    return null
  }
}

/**
 * Reads the raw Starfleet record out of the capture window's own origin.
 *
 * Says why it came back empty rather than just coming back empty: the three
 * ways this fails — wrong origin, wrong store, unreadable record — look
 * identical from the outside and only one of them is ours to fix.
 */
async function readStarfleetRecord(window: BrowserWindow): Promise<unknown> {
  const deadline = Date.now() + STARFLEET_READ_MS
  let last: StarfleetProbe = {}

  while (Date.now() < deadline) {
    if (window.isDestroyed()) break

    const probe = (await window.webContents
      .executeJavaScript(READ_STARFLEET_SESSION)
      .catch((error: unknown) => ({
        error: error instanceof Error ? error.message : 'probe failed'
      }))) as StarfleetProbe | null

    last = probe ?? {}
    if (last.record) return last.record
    // No databases at all means the document is still the empty one the window
    // starts on. Anything else is a real answer, and retrying will not change it.
    if ((last.databases ?? 0) > 0) break

    await new Promise((resolve) => setTimeout(resolve, STARFLEET_RETRY_MS))
  }

  console.warn(
    'Starfleet session not read; library sync will be refused: ' +
      `databases=${last.databases ?? 0} stores=${last.stores ?? 0}` +
      (last.error ? ` error=${last.error}` : '')
  )
  return null
}

/**
 * Loads the GFN web client and resolves with the first complete set of
 * credentials it sends.
 *
 * Requests are correlated by id so the body-derived `vpcId` is matched to the
 * headers of the *same* request; a global "last seen" would be a race the
 * moment two queries overlap.
 */
/**
 * webRequest listeners are per-session and there is only one slot each, so two
 * overlapping captures would tear down each other's hooks. Serialise them.
 */
let capturing: Promise<CapturedSession> | null = null

export async function captureSession(options: CaptureOptions): Promise<CapturedSession> {
  // Every caller waits on whatever is already in flight, and only *one* of them
  // starts a replacement when that fails.
  //
  // The obvious `while (capturing) { try { return await capturing } catch
  // { break } }` is subtly wrong, and wrong in exactly the way this variable
  // exists to prevent: when two callers are waiting on the same failed capture,
  // both leave the loop and both go on to start one, so two windows race and
  // tear down each other's webRequest hooks. Retiring the promise under a
  // `===` check makes the second waiter come back round the loop and find the
  // replacement the first one started.
  for (;;) {
    const pending = capturing
    if (!pending) break
    try {
      return await pending
    } catch {
      if (capturing === pending) capturing = null
    }
  }

  const started = runCapture(options)
  capturing = started
  try {
    return await started
  } finally {
    // Only if nothing has replaced it in the meantime, so a late `finally`
    // cannot drop somebody else's live capture on the floor.
    if (capturing === started) capturing = null
  }
}

async function runCapture(options: CaptureOptions): Promise<CapturedSession> {
  // Headless captures now wait for a real catalog call rather than the first
  // token in sight, and the app boots cold because the caches were just
  // dropped. 45s was not enough headroom for that.
  const { interactive, timeoutMs = interactive ? 300_000 : 90_000 } = options
  const ses = getAuthSession()

  const window = new BrowserWindow({
    width: 1100,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#08090c',
    title: 'Sign in to GeForce NOW',
    webPreferences: {
      session: ses,
      // This window renders a third-party site. It gets no bridge and no Node —
      // it exists only so the user can sign in.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The one script that goes in, and it is not a bridge.
      //
      // This page is the only part of the product a pad cannot drive, which is
      // why linking an account used to need a mouse and a keyboard that nobody
      // has on a sofa. `pointer.cjs` reads the pad in the isolated world and
      // draws a cursor over the page; it calls `exposeInMainWorld` nowhere, so
      // the site gains nothing it did not already have — `window.launcher` and
      // `require` are both still undefined in the world NVIDIA's code runs in.
      preload: POINTER_PRELOAD
    }
  })

  // Paired with the preload above rather than left to a caller. A window with
  // the script and no registration is a cursor whose every command main
  // refuses, and the symptom of that is a pad that does nothing.
  registerPointerTarget(window, 'the sign-in window')

  // Token and vpcId are gathered independently and combined when both are in.
  const found: {
    token: string | null
    rank: number
    clientId: string
    clientVersion: string
    endpoint: string | null
    vpcId: string | null
  } = { token: null, rank: 0, clientId: '', clientVersion: '', endpoint: null, vpcId: null }
  let capturedHeaders: Record<string, string> = {}

  /** Diagnostics, so a failure can be read off the log instead of guessed at. */
  const seenHosts = new Set<string>()
  const authorizedUrls = new Set<string>()
  const stats = { graphqlPosts: 0, withUploadData: 0, bodiesParsed: 0 }
  const postUrls = new Set<string>()
  const apiShapes = new Set<string>()
  const apiRequestLog: string[] = []
  let tokenSource = 'none'
  let haveAuthorized = false
  let authScheme = 'none'

  // Deliberately not clearing any storage here.
  //
  // An earlier version dropped cachestorage and serviceworkers to force real
  // network calls, on the theory that a warm service worker was answering
  // everything. That diagnosis was wrong — the real cause was completing the
  // capture before the app had loaded its catalog — and unregistering the
  // service worker on every run is not free: the web app initialises through
  // it, so wiping it can leave the session unauthenticated, which is exactly
  // what the last run showed (six GraphQL calls, none carrying a credential).

  const cookies = await ses.cookies.get({ domain: 'geforcenow.com' })
  const nvidiaCookies = await ses.cookies.get({ domain: 'nvidia.com' })
  console.log(
    `GFN capture starting: interactive=${interactive} ` +
      `cookies geforcenow=${cookies.length} nvidia=${nvidiaCookies.length}`
  )

  return new Promise<CapturedSession>((resolve, reject) => {
    let settled = false
    let graceTimer: NodeJS.Timeout | null = null

    const finish = (error: Error | null, result?: CapturedSession): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (graceTimer) clearTimeout(graceTimer)
      ses.webRequest.onBeforeRequest(ALL_URLS, null)
      ses.webRequest.onBeforeSendHeaders(ALL_URLS, null)
      if (!window.isDestroyed()) window.destroy()

      if (error) {
        console.error(
          `GFN capture failed: ${error.message}. ` +
            `authorized=${haveAuthorized ? 'yes' : 'NEVER SEEN'} ` +
            `vpcId=${found.vpcId ? 'yes' : 'no'} ` +
            `rank=${found.rank} graphqlPosts=${stats.graphqlPosts} ` +
            `withBody=${stats.withUploadData} parsed=${stats.bodiesParsed}\n` +
            `  authorized requests: ${[...authorizedUrls].join(' | ') || 'none'}\n` +
            `  hosts: ${[...seenHosts].join(', ') || 'none'}`
        )
        reject(error)
      } else {
        resolve(result!)
      }
    }

    // `complete` can be reached twice — once when the vpcId lands and once from
    // the grace timer — and it is now asynchronous, so the second caller would
    // otherwise start a second read against a window the first is tearing down.
    let completing = false

    const complete = (): void => {
      if (settled || completing) return
      completing = true

      // The overall timeout is what would otherwise fire *during* the read and
      // reject a session that was in fact captured. Nothing after this point
      // can hang: the read races its own deadline.
      clearTimeout(timer)

      void readStarfleetRecord(window).then((record) => {
        const idToken = readIdToken(record)
        const endpoint = found.endpoint ?? DEFAULT_GRAPHQL_ENDPOINT
        console.log(
          `GFN session captured: endpoint=${endpoint} ` +
            `authScheme=${authScheme}\n` +
            `  token from: ${tokenSource}\n` +
            // Presence only. This one is a live credential for ALS.
            `  starfleet idToken: ${idToken ? 'yes' : 'no'}\n` +
            `  vpcId=${found.vpcId ?? 'MISSING'} graphqlPosts=${stats.graphqlPosts} ` +
            `withBody=${stats.withUploadData} parsed=${stats.bodiesParsed}\n` +
            `  client request shapes: ${[...apiShapes].join(' | ') || 'none'}\n` +
            `  headers kept: ${Object.keys(capturedHeaders).join(', ') || 'none'}\n` +
            `  authorized: ${[...authorizedUrls].join(' | ') || 'none'}\n` +
            `  POSTs: ${[...postUrls].join(' | ') || 'none'}`
        )
        finish(null, {
          token: found.token,
          idToken,
          vpcId: found.vpcId ?? '',
          endpoint,
          clientId: found.clientId,
          clientVersion: found.clientVersion,
          headers: capturedHeaders
        })
      })
    }

    /**
     * Resolves once the session can actually be used.
     *
     * What makes it usable is having seen a real GraphQL call: that yields the
     * endpoint and the headers, and proves the partition's cookies are
     * authenticated. A vpcId completes the picture, so wait a little for one
     * before settling without it.
     */
    const maybeComplete = (): void => {
      // An authenticated GraphQL call is the bar. Completing on an anonymous
      // one produced a session whose every query came back
      // `FORBIDDEN / data:{apps:null}` — parsed and resolved, then denied,
      // because the request carried no credential. Several of the client's
      // early GraphQL calls are public (UI strings, the login wall), so seeing
      // GraphQL traffic is not on its own evidence of being signed in.
      if (settled || !found.endpoint || !haveAuthorized) return
      if (found.vpcId) {
        complete()
        return
      }
      graceTimer ??= setTimeout(complete, VPC_GRACE_MS)
    }

    const timer = setTimeout(() => {
      finish(
        new Error(
          interactive
            ? 'Signed in, but no authenticated GeForce NOW request was seen — sign in again'
            : 'Stored GeForce NOW session is no longer valid — sign in again'
        )
      )
    }, timeoutMs)

    ses.webRequest.onBeforeRequest(ALL_URLS, (details, callback) => {
      callback({})
      if (settled) return

      if (details.method === 'POST') {
        try {
          const u = new URL(details.url)
          postUrls.add(`${u.host}${u.pathname}`)
        } catch {
          // Not a URL worth recording.
        }
      }

      if (!isApiRequest(details.url)) return

      stats.graphqlPosts += 1
      if (details.uploadData?.length) stats.withUploadData += 1

      const vpcId = readVpcId(details.uploadData) ?? readVpcIdFromUrl(details.url)
      if (vpcId) stats.bodiesParsed += 1
      if (vpcId && !found.vpcId) {
        found.vpcId = vpcId
        maybeComplete()
      }
    })

    ses.webRequest.onBeforeSendHeaders(ALL_URLS, (details, callback) => {
      callback({ requestHeaders: details.requestHeaders })
      if (settled) return

      try {
        seenHosts.add(new URL(details.url).host)
      } catch {
        // Not a URL worth recording.
      }

      const authorization = headerValue(details.requestHeaders, 'Authorization')
      const url = new URL(details.url)
      if (authorization) authorizedUrls.add(`${details.method} ${url.host}${url.pathname}`)

      if (!isApiRequest(details.url)) return

      apiShapes.add(`${details.method} ?${[...url.searchParams.keys()].join('&') || '(none)'}`)

      if (apiRequestLog.length < 8) {
        apiRequestLog.push(
          `${details.method} ${url.searchParams.get('requestType') ?? '?'} ` +
            `[${Object.keys(details.requestHeaders).join(',')}]`
        )
      }

      // A bearer is welcome but optional; the cookies do the work. The header
      // is replayed verbatim either way, since the client does not always use
      // the Bearer scheme.
      const token = authorization?.startsWith('Bearer ')
        ? authorization.slice('Bearer '.length).trim()
        : null
      if (token) {
        found.token = token
        tokenSource = `${details.method} ${url.host}${url.pathname}`
      }

      // Some GraphQL calls carry an Authorization header and some do not.
      // Once one has been seen, never downgrade to a capture without it.
      if (haveAuthorized && !authorization) return
      if (authorization) {
        haveAuthorized = true
        // Scheme only — never the credential itself.
        authScheme = authorization.split(' ')[0] ?? 'unknown'
      }

      found.rank = 2
      capturedHeaders = collectHeaders(details.requestHeaders)
      found.endpoint = `${url.origin}${url.pathname}`
      found.clientId = headerValue(details.requestHeaders, 'NV-Client-ID') ?? found.clientId
      found.clientVersion =
        headerValue(details.requestHeaders, 'NV-Client-Version') ?? found.clientVersion

      maybeComplete()
    })

    // Only reveal the window once it has something to show, and only when the
    // user is meant to act. A headless top-up should never steal focus — that
    // would kill gamepad input in the launcher.
    window.once('ready-to-show', () => {
      if (interactive) window.show()
    })

    window.on('closed', () => {
      // On success the window is torn down by finish() before this fires, so
      // reaching here means the user closed it early. Say what to do next
      // rather than just naming the event.
      finish(
        new Error(
          found.token
            ? 'Closed before the session could be read — try signing in again'
            : 'Sign-in was cancelled. Leave the window open until it closes itself.'
        )
      )
    })

    window.loadURL(GFN_WEB_URL).catch((error: unknown) => {
      finish(error instanceof Error ? error : new Error('Could not load GeForce NOW'))
    })
  })
}
