/**
 * The catalog as it comes off the wire, and the two decisions both mappers have
 * to agree on.
 *
 * Its own module so that `catalog.ts` (tiles) and `details.ts` (the panel) can
 * share this vocabulary without importing each other. Nothing here reaches past
 * the shape of a response: turning it into the launcher's model is the mappers'
 * job, and a GFN schema change should stop at them.
 */

export interface RawVariant {
  id?: string | number | null
  appStore?: string | null
  shortName?: string | null
  /** The store's own id for this title — a Steam appid, an Epic GUID. */
  storeId?: string | null
  /** The store's product page, with NVIDIA's campaign parameters attached. */
  storeUrl?: string | null
  /** Public feed only: GAMEPAD, GAMEPAD_PARTIAL, KEYBOARD, MOUSE, WHEEL… */
  supportedControls?: string[] | null
  /** Public feed only: XBOX_GAME_PASS, UBISOFT_PREMIUM… */
  subscriptions?: string[] | null
  gfn?: {
    status?: string | null
    releaseDate?: string | null
    /**
     * What GFN streams this edition with: `RTX_ENABLED`, `HDR_ENABLED`,
     * `REFLEX_ENABLED`. Only ever emitted as `"true"` — a key that is absent is
     * the feed saying no, not saying nothing.
     */
    features?: ({ key?: string | null; value?: string | null } | null)[] | null
    library?: { status?: string | null; selected?: boolean | null } | null
  } | null
}

/**
 * One catalog entry.
 *
 * Both feeds — the authenticated GraphQL API and the public game list — are
 * shaped closely enough to share this type and `mapApp`. Fields either only one
 * of them returns are optional, which is what lets a single mapper serve both.
 */
export interface RawApp {
  id?: string | number | null
  title?: string | null
  sortName?: string | null
  /** Public feed only: `GAME`, or a DLC/prerequisite entry we do not want. */
  type?: string | null
  publisherName?: string | null
  developerName?: string | null
  genres?: string[] | null
  /** Public feed only, and localised by the request's `language`. */
  shortDescription?: string | null
  /** Most entries are a single URL; `SCREENSHOTS` is a list. */
  images?: Record<string, string | string[] | null> | null
  variants?: RawVariant[] | null
  gfn?: {
    playabilityState?: string | null
    minimumMembershipTierLabel?: string | null
  } | null
}

/** A variant counts as owned unless GFN explicitly says it is not. */
export function variantOwned(variant: RawVariant): boolean {
  const status = variant.gfn?.library?.status
  return Boolean(status) && status !== 'NOT_OWNED' && status !== 'LIBRARY_NOT_FOUND'
}

/**
 * Whether GFN streams this edition with ray tracing.
 *
 * The flag is per *variant*, not per app, and 17 of the 171 ray-traced titles
 * disagree across their stores — Black Ops 6 has it on one of four editions.
 * A game still gets one badge: the GFN client itself asks
 * `variants.some(hasFeature)`, so the launcher does too rather than inventing a
 * stricter rule and showing the user less than NVIDIA's own UI does.
 */
export function variantRtx(variant: RawVariant): boolean {
  return (variant.gfn?.features ?? []).some(
    (feature) => feature?.key === 'RTX_ENABLED' && feature.value === 'true'
  )
}

/** One image URL, ignoring the keys that hold a list. */
export function imageUrl(raw: RawApp, key: string): string | null {
  const value = raw.images?.[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * The variant a launch should target.
 *
 * Shared because the two mappers have to agree exactly: the details panel is
 * keyed by the id this returns, and a disagreement would show an empty panel
 * for a game whose data is perfectly good.
 */
export function pickLaunchVariant(variants: RawVariant[]): RawVariant | undefined {
  return (
    variants.find((variant) => variant.gfn?.library?.selected) ??
    variants.find(variantOwned) ??
    // Nothing known about ownership — the public feed never carries any — so
    // fall back to the store most people have rather than to whichever variant
    // happens to come first. Steam is 5.709 of the catalog's 6.918 variants,
    // and pointing at a store the user does not own costs them one prompt
    // inside GFN rather than a failed launch.
    variants.find((variant) => variant.appStore === 'STEAM') ??
    variants[0]
  )
}
