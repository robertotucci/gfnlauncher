/**
 * Where a new version of the launcher comes from.
 *
 * The same arrangement as `@shared/donate`, for the same reason: both sides
 * import these constants, so the renderer never sends a URL across the bridge
 * for the main process to fetch or open. `update:check` takes a boolean and
 * nothing else, and the QR code on the update notice is drawn from the constant
 * below rather than from anything main handed over — there is no argument to
 * forge, which is stronger than validating one.
 *
 * GitHub Releases rather than a manifest of our own: the release workflow
 * already publishes all three artefacts there, with a sha256 digest per asset,
 * and a second place to publish a version number is a second place for it to be
 * wrong. `update.test.ts` pins the owner and repository for the same reason
 * `donate.test.ts` pins the hosted button id — nobody proofreads a URL that
 * only a background request ever visits.
 */

const OWNER = 'robertotucci'
const REPOSITORY = 'gfnlauncher'

/**
 * The newest published release, as JSON.
 *
 * `/releases/latest` deliberately: it excludes drafts and pre-releases, so a
 * beta tag pushed for testing cannot be offered to everyone on a television.
 */
export const LATEST_RELEASE_API_URL = `https://api.github.com/repos/${OWNER}/${REPOSITORY}/releases/latest`

/** The same release as a page a person can read. What the QR code encodes. */
export const LATEST_RELEASE_PAGE_URL = `https://github.com/${OWNER}/${REPOSITORY}/releases/latest`
