/**
 * Where a donation goes.
 *
 * One constant, imported by both sides, so the renderer never sends a URL
 * across the bridge for the main process to open. `app:openDonation` takes no
 * argument at all — there is nothing to validate, which is stronger than
 * validating it.
 *
 * The same link is in `README.md` and in the `<url type="donation">` of the
 * AppStream metainfo. All three have to agree.
 */
export const DONATION_URL = 'https://www.paypal.com/donate/?hosted_button_id=6TJMUEWLPE95Y'
