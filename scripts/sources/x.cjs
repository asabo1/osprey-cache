/* X (Twitter) Source adapter STUB. Disabled unless X_BEARER_TOKEN is set.
 * Interface (spec section 6): fetchSince(cursor) -> { posts: SourcePost[], cursor, volume }.
 * SourcePost { id, source: 'x', ts, text, author?, engagement?, desk?, cluster_size? }.
 * Config: config/x-sources.json. Real calls (search/recent, counts/recent, users/:id/tweets)
 * are not implemented yet; add them when the key and spend limit exist. */
const cfg = require('../../config/x-sources.json');

const name = 'x';
const costPerPost = 0.005;
const enabled = () => !!process.env.X_BEARER_TOKEN;

async function fetchSince(cursor) {
  if (!enabled()) return { posts: [], cursor: cursor || null, volume: null };
  // TODO: GET /2/tweets/search/recent per desk query in cfg.queries, since_id = cursor,
  // cap cfg.sample_per_desk_per_hour, dedupe by token Jaccard >= 0.8 within 6h.
  return { posts: [], cursor: cursor || null, volume: null };
}

module.exports = { name, costPerPost, enabled, fetchSince, config: cfg };
