/**
 * "This listing has settled recently enough to stay discoverable."
 *
 * The CDP Bazaar index is a rolling window: a resource enters on a settled
 * payment and drops out when the payments stop. Four of ours fell out inside a
 * single day, which is the loop worth naming — a listing nobody buys becomes a
 * listing nobody can find, which keeps it unbought.
 *
 * Two writers share this key, and that is the whole point of it living here
 * rather than in either of them: the index-refresh cron sets it when it pays to
 * keep a quiet endpoint alive, and the paid route sets it when a real customer
 * does the same thing for free. Every organic purchase therefore removes an
 * endpoint from the cron's next run.
 */

/** Comfortably inside the index's ~30-day window, so one missed run is harmless. */
export const INDEX_FRESH_SECONDS = 21 * 24 * 60 * 60;

export const indexFreshKey = (serviceId: string) => `idx:${serviceId}`;
