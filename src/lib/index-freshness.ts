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

/**
 * WHEN it last settled, not just whether it settled recently.
 *
 * `indexFreshKey` is a TTL flag, so every stale service looks identically
 * stale: one that went stale an hour ago is indistinguishable from one that is
 * a day from eviction. The refresh cron can only pay for twelve a day, so with
 * a backlog it was picking them in catalogue order — which on 2026-09-05 left
 * ten services inside their last ten days while the conveyor refreshed ones
 * with three weeks of margin. Ordering by this timestamp spends the same budget
 * on whatever is closest to falling out.
 *
 * Its TTL outlives the index's 30-day eviction window on purpose: a service
 * whose timestamp has expired has certainly evicted, and sorts ahead of one
 * that merely looks old.
 */
export const INDEX_SEEDED_SECONDS = 45 * 24 * 60 * 60;

export const indexSeededKey = (serviceId: string) => `idx:seeded:${serviceId}`;

/**
 * Services the discovery index does not have, as last measured by
 * cron/index-gap.
 *
 * The keepalive decides what to refresh from `indexFreshKey`, which records
 * what WE settled. The index forms its own view, and only when a settlement
 * actually produces a record. The two drift — and on 2026-09-14 eleven services
 * were absent from discovery while all eleven read as fresh here, so the cron
 * was never going to touch them. We had paid to keep them alive, the payment
 * had kept nothing alive, and nothing would have retried.
 *
 * index-gap already measures this four times a day. Writing it down is what
 * lets index-all override its own freshness for the services that need it.
 * TTL outlives a full day of missed runs so a single failed check does not
 * silently drop the override.
 */
export const MISSING_KEY = "index:missing";
