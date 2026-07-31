/**
 * Website rules are enforced on the device by matching DNS queries, so a rule
 * has to be a bare hostname. Parents type what they see in the address bar —
 * `https://youtube.com/feed`, `www.Example.COM`, `example.com:8443` — and any
 * of those would silently never match a DNS name.
 *
 * Normalising at the point the rule is created keeps the stored value, what the
 * parent sees in the dashboard, and what the device enforces all the same thing.
 */

/** Matches a hostname: labels of alphanumerics/hyphens, at least one dot. */
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * @returns {string|null} the bare hostname, or null if it is not one.
 */
const normalizeDomain = (input) => {
  if (typeof input !== 'string') return null;

  let value = input.trim().toLowerCase();
  if (!value) return null;

  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // scheme
  value = value.split(/[/?#]/)[0];                      // path, query, fragment
  value = value.split('@').pop();                       // credentials
  value = value.split(':')[0];                          // port
  value = value.replace(/\.+$/, '');                    // trailing dots

  // The device matches subdomains of whatever is stored, so dropping a leading
  // `www.` makes "block www.example.com" also cover the bare domain — which is
  // what a parent means by it.
  value = value.replace(/^www\./, '');

  return HOSTNAME.test(value) ? value : null;
};

module.exports = { normalizeDomain };
