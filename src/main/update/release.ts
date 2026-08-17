/**
 * A GitHub release, read as data.
 *
 * Everything here is pure, and it is this feature's `mapSummary`: the one place
 * GitHub's wire schema is allowed to be visible, so a change on their side stops
 * at a single function. Nothing below touches the network — `checkForUpdate` in
 * `index.ts` does the fetch and hands the JSON here.
 *
 * The digest matters more than anything else on this file. `parseRelease` reads
 * each asset's sha256 out of the payload, and `download.ts` refuses to install
 * an artefact whose bytes do not match it. An unverified binary that replaces
 * the launcher is not something to be relaxed about.
 */

import type { UpdateChannel } from '@shared/types'
import { normaliseVersion } from '@shared/version'

/** How many release-note lines the notice shows. Four is a screenful at three metres. */
const MAX_NOTES = 4

/** Where a note is cut. About three lines at the notice's width. */
const MAX_NOTE_CHARS = 160

/**
 * How long a bold lead has to be before it can stand in for its bullet.
 *
 * Changelog entries here open two different ways, and only one of them is a
 * headline. `**Starting a game no longer minimises the launcher**, and the
 * setting is gone with it.` is a sentence that says something on its own;
 * `**Recent**, a chronology of what you played.` is a *label* followed by the
 * sentence. Taking the lead unconditionally turned the v0.1.0 notes into a list
 * of nouns — "Recent", "Details panel", "Library and ownership" — which is a
 * table of contents, not news.
 *
 * Thirty characters is where a label stops and a sentence starts in this
 * changelog. It is a heuristic and it is allowed to be: being wrong costs one
 * note reading slightly longer than it needed to.
 */
const MIN_LEAD_CHARS = 30

export interface ReleaseAsset {
  name: string
  /** `browser_download_url` — a redirect to the CDN, which `fetch` follows. */
  url: string
  bytes: number
  /** Lowercase hex, or null when GitHub sent no digest for this asset. */
  sha256: string | null
}

export interface ReleaseInfo {
  /** Normalised, without the tag's `v`. */
  version: string
  tag: string
  pageUrl: string
  /** ISO 8601, or null. */
  publishedAt: string | null
  notes: string[]
  assets: ReleaseAsset[]
}

/**
 * Turns `/releases/latest` into the launcher's model, or null when it is not a
 * release we should act on.
 *
 * Drafts and pre-releases are rejected here as well as by the endpoint. The
 * endpoint already excludes both, so this is belt to that braces — and the
 * braces are one URL constant away from being changed by somebody who did not
 * know the endpoint was doing the filtering.
 */
export function parseRelease(raw: unknown): ReleaseInfo | null {
  const root = asRecord(raw)
  if (!root) return null
  if (root.draft === true || root.prerelease === true) return null

  const tag = asString(root.tag_name)
  const version = normaliseVersion(tag)
  if (!tag || !version) return null

  return {
    version,
    tag,
    pageUrl: asString(root.html_url) ?? '',
    publishedAt: asString(root.published_at) ?? asString(root.created_at),
    notes: summariseNotes(root.body),
    assets: Array.isArray(root.assets) ? root.assets.map(asAsset).filter(isAsset) : []
  }
}

/**
 * Reduces a release body to a few lines somebody can read from a sofa.
 *
 * Written against the body this project actually publishes, which is not
 * arbitrary markdown: CI copies one `## [x.y.z]` section out of `CHANGELOG.md`
 * and appends an `## Install` section of its own. Two things follow.
 *
 * **It stops at the first `## `.** That heading is the appended install
 * instructions — a fenced `flatpak install` command and two links — and none of
 * it is news about the release.
 *
 * **It prefers a bullet's bold lead over the bullet.** Every changelog entry
 * here is written as a bold headline sentence followed by the reasoning:
 * `**Starting a game no longer minimises the launcher**, and the setting is
 * gone with it. GeForce NOW raises itself, so…`. The headline is already the
 * three-metre version of the paragraph, written by hand, so using it beats
 * truncating the paragraph at a character count. Entries without one fall back
 * to exactly that.
 */
export function summariseNotes(body: unknown): string[] {
  if (typeof body !== 'string') return []

  const lines = body.split(/\r?\n/)
  const notes: string[] = []
  const plain: string[] = []

  for (const line of lines) {
    // The appended install section, and anything after it.
    if (/^##\s/.test(line)) break

    const trimmed = line.trim()
    if (!trimmed) continue

    const bullet = /^[-*]\s+(.*)$/.exec(trimmed)
    if (bullet?.[1]) {
      notes.push(condense(bullet[1]))
      if (notes.length === MAX_NOTES) break
      continue
    }

    // Kept as the fallback for a release whose notes are prose rather than a
    // changelog section. Sub-headings (`### Added`) are not content.
    if (!/^#{1,6}\s/.test(trimmed)) plain.push(condense(trimmed))
  }

  if (notes.length > 0) return notes
  return plain.slice(0, 3)
}

/** One note: the bold lead when it stands alone, otherwise the whole line. */
function condense(markdown: string): string {
  const lead = /^\*\*(.+?)\*\*/.exec(markdown)?.[1]
  const stripped = lead ? stripMarkdown(lead) : null
  if (stripped && stripped.length >= MIN_LEAD_CHARS) return truncate(stripped)
  return truncate(stripMarkdown(markdown))
}

/**
 * Enough markdown to render as text.
 *
 * Not a parser and deliberately not one: this runs over five lines of a
 * changelog written in this repository, and the failure mode of missing a
 * construct is a stray asterisk on screen.
 */
function stripMarkdown(value: string): string {
  return value
    // `[text](url)` — the URL is unreachable from a television anyway.
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|\W)\*([^*]+)\*/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Cut at a sentence if one ends in range, otherwise at a word.
 *
 * Changelog entries here run two or three sentences: a headline, then the
 * reasoning. Cutting at a character count lands mid-clause and leaves an
 * ellipsis on nearly every line — four of them stacked up reads as though the
 * launcher could not be bothered to finish a thought. Ending on a full stop
 * costs a few characters and needs no ellipsis at all, because nothing was
 * interrupted.
 *
 * The half-limit floor is what stops a note from being cut down to its first
 * three words because that is where the only full stop happened to be.
 */
function truncate(value: string): string {
  if (value.length <= MAX_NOTE_CHARS) return value

  const window = value.slice(0, MAX_NOTE_CHARS)
  const sentence = window.lastIndexOf('. ')
  if (sentence >= MAX_NOTE_CHARS * 0.5) return window.slice(0, sentence + 1)

  const space = window.lastIndexOf(' ')
  return `${(space > MAX_NOTE_CHARS * 0.6 ? window.slice(0, space) : window).trimEnd()}…`
}

/**
 * The artefact this install form would download.
 *
 * Matched on the extension rather than on the exact filename: electron-builder
 * names the AppImage after `productName`, so it is `GFN.Launcher-0.1.0.AppImage`
 * today and whatever the product is called tomorrow. The extension is the part
 * that is a contract.
 *
 * Null for `flatpak`, and that is not an oversight: the Flatpak path runs
 * `flatpak update` and downloads nothing itself. The bundle in the release is
 * for a first install, not an upgrade.
 */
export function pickAsset(
  assets: readonly ReleaseAsset[],
  channel: UpdateChannel
): ReleaseAsset | null {
  const suffix = channel === 'appimage' ? '.appimage' : channel === 'system' ? '.deb' : null
  if (!suffix) return null
  return assets.find((asset) => asset.name.toLowerCase().endsWith(suffix)) ?? null
}

function asAsset(raw: unknown): ReleaseAsset | null {
  const record = asRecord(raw)
  const name = asString(record?.name)
  const url = asString(record?.browser_download_url)
  if (!record || !name || !url) return null

  return {
    name,
    url,
    bytes: typeof record.size === 'number' && record.size > 0 ? record.size : 0,
    sha256: asDigest(record.digest)
  }
}

function isAsset(asset: ReleaseAsset | null): asset is ReleaseAsset {
  return asset !== null
}

/**
 * `"sha256:4437e149…"` as GitHub sends it, validated down to 64 hex characters.
 *
 * Anything else — a different algorithm, a truncated value, a missing field on
 * an older release — is null, and null means `download.ts` will refuse to
 * install. A digest that is merely *present* proves nothing; one that is the
 * right shape is the thing worth comparing against.
 */
function asDigest(value: unknown): string | null {
  const raw = asString(value)
  if (!raw) return null
  const hex = raw.toLowerCase().replace(/^sha256:/, '')
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}
