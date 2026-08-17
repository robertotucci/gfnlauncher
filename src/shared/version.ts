/**
 * Semantic version comparison, for deciding whether a release is worth telling
 * the user about.
 *
 * Pure and shared, in the same spirit as `buildPowerArgv`: what comes out of
 * here decides whether the launcher offers to replace its own binary, so the
 * suite has to be able to assert every ordering without a network or a release.
 *
 * Full semver precedence rather than a three-number compare, and specifically
 * because of the pre-release rule: `0.2.0-beta.1` is **older** than `0.2.0`, so
 * a naive numeric split would offer a beta as an upgrade over the stable build
 * it precedes. GitHub's `/releases/latest` excludes pre-releases, which makes
 * that unreachable today and would make it a silent regression the day someone
 * points this at a different endpoint.
 */

/** Core version numbers, or null when the string is not a version at all. */
interface Parsed {
  /** major, minor, patch — missing trailing parts read as 0. */
  core: [number, number, number]
  /** Dot-separated pre-release identifiers, empty for a stable release. */
  pre: string[]
}

/**
 * Splits a version string, tolerating the `v` prefix that tags carry.
 *
 * Build metadata (`+abc`) is dropped rather than compared: semver says it is
 * explicitly not part of precedence, and two builds of the same version are the
 * same version as far as "should I offer this" is concerned.
 */
export function parseSemver(value: unknown): Parsed | null {
  if (typeof value !== 'string') return null

  const withoutBuild = value.trim().replace(/^[vV]/, '').split('+')[0] ?? ''
  const [core, ...preParts] = withoutBuild.split('-')
  if (!core) return null

  const numbers = core.split('.')
  if (numbers.length === 0 || numbers.length > 3) return null

  const parsed: number[] = []
  for (const part of numbers) {
    // `Number('')` is 0 and `Number('1x')` is NaN, so both have to be caught:
    // "1..2" and "1.2.x" are not versions and must not compare as though they
    // were. A version we cannot read is one we refuse to act on.
    if (!/^\d+$/.test(part)) return null
    parsed.push(Number(part))
  }

  return {
    core: [parsed[0] ?? 0, parsed[1] ?? 0, parsed[2] ?? 0],
    // Re-joined because a pre-release may itself contain hyphens ("1.0.0-rc-1").
    pre: preParts.length > 0 ? preParts.join('-').split('.').filter(Boolean) : []
  }
}

/** Normalised `x.y.z[-pre]`, or null. What the UI prints, so `v` never doubles up. */
export function normaliseVersion(value: unknown): string | null {
  const parsed = parseSemver(value)
  if (!parsed) return null
  const core = parsed.core.join('.')
  return parsed.pre.length > 0 ? `${core}-${parsed.pre.join('.')}` : core
}

/**
 * Standard comparator: negative when `a` sorts before `b`, 0 when equal.
 *
 * Unparseable strings sort *first*, so an unreadable candidate never wins
 * against a readable current version. `isNewerVersion` is the only caller that
 * matters and it depends on that.
 */
export function compareVersions(a: unknown, b: unknown): number {
  const left = parseSemver(a)
  const right = parseSemver(b)
  if (!left && !right) return 0
  if (!left) return -1
  if (!right) return 1

  for (let index = 0; index < 3; index += 1) {
    const diff = (left.core[index] ?? 0) - (right.core[index] ?? 0)
    if (diff !== 0) return diff < 0 ? -1 : 1
  }

  // A pre-release is older than the release it leads up to, and a release has
  // no pre-release identifiers to compare.
  if (left.pre.length === 0 && right.pre.length === 0) return 0
  if (left.pre.length === 0) return 1
  if (right.pre.length === 0) return -1

  const length = Math.max(left.pre.length, right.pre.length)
  for (let index = 0; index < length; index += 1) {
    const one = left.pre[index]
    const other = right.pre[index]
    // A shorter set of identifiers sorts first when everything before it ties:
    // "1.0.0-rc" precedes "1.0.0-rc.1".
    if (one === undefined) return -1
    if (other === undefined) return 1
    if (one === other) continue

    const oneNumeric = /^\d+$/.test(one)
    const otherNumeric = /^\d+$/.test(other)
    if (oneNumeric && otherNumeric) return Number(one) < Number(other) ? -1 : 1
    // Numeric identifiers always have lower precedence than alphanumeric ones.
    if (oneNumeric !== otherNumeric) return oneNumeric ? -1 : 1
    return one < other ? -1 : 1
  }

  return 0
}

/**
 * Whether `candidate` is worth offering over `current`.
 *
 * Equal is not newer, and neither is older — a launcher built from a tag ahead
 * of the last release (which is every development build between two releases)
 * must not be told to downgrade itself.
 */
export function isNewerVersion(candidate: unknown, current: unknown): boolean {
  if (parseSemver(candidate) === null) return false
  return compareVersions(candidate, current) > 0
}
