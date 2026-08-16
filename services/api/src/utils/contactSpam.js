/**
 * Spam checks for the public contact form.
 *
 * The only protection this form had was an IP rate limiter — five submissions
 * per fifteen minutes. That bounds the volume from one address and stops nothing
 * else: a single bot is entitled to five messages every quarter of an hour, for
 * ever, and a distributed one is not touched at all. On the one endpoint on the
 * platform that accepts a body from an unauthenticated stranger and mails it to
 * a person, that is thin.
 *
 * Four checks, deliberately in this order — cheapest and most certain first, so
 * an obvious bot never reaches the database:
 *
 *   honeypot   A field no human can see and every naive bot fills in.
 *   timing     A form submitted faster than anyone could have typed it.
 *   content    The shape of link-spam, which is what actually arrives.
 *   duplicate  The same message again, which is a retry loop or a bot.
 *
 * Nothing here is a CAPTCHA and none of it should be. A CAPTCHA on a support
 * form taxes every genuine person — disproportionately the ones already having
 * trouble — to inconvenience a bot that solves it for a tenth of a cent. These
 * checks cost a legitimate sender nothing at all.
 *
 * **A refusal is never silent and never lost.** Every one of these can be wrong,
 * and the cost of being wrong is a customer who believes they contacted support
 * and did not. So a refused message is still stored, marked `spam` with the
 * reason, and the sender is told their message was received rather than being
 * shown an accusation they cannot argue with. What a refusal actually costs is
 * the notification email — which is the thing being protected.
 */
const { Op } = require('sequelize');

/** How quickly a human could plausibly fill this form in. */
const MIN_FILL_SECONDS = 3;

/** How far back the duplicate check looks. */
const DUPLICATE_WINDOW_MS = 60 * 60 * 1000;

/** Above this many links, a support message is not a support message. */
const MAX_LINKS = 2;

const LINK_PATTERN = /\b(?:https?:\/\/|www\.)\S+/gi;

/**
 * Phrases that are only ever a pitch *to* us, never a question *from* a parent.
 *
 * The obvious list to write here is a list of seedy topics — crypto investment,
 * casino bonuses, binary options, buying followers — and on this product that
 * list is actively dangerous. Parentix sells child safety: the parents who write
 * in are *precisely* the people who say "my daughter is being shown casino bonus
 * ads" or "is there a way to block crypto investment apps". A topic filter would
 * refuse the messages this company most needs to read, and because a refusal is
 * silent to the sender (deliberately — see the header) they would believe they
 * had reached support and never find out otherwise.
 *
 * So the test each phrase has to pass is not "does spam say this" but "could a
 * worried parent say this". What survives is unsolicited B2B marketing, which is
 * what actually arrives and which no customer has any reason to write.
 *
 * Matched on word boundaries, so "backlink" cannot fire on a message that
 * happens to contain it inside a longer word. A multi-word phrase matches across
 * ordinary whitespace only, which `normalise` has already collapsed.
 */
const SPAM_PHRASES = [
  'seo services', 'guest post', 'link building', 'backlink',
  'rank #1 on google', 'increase your traffic', 'improve your search ranking',
  'boost your rankings', 'web design services', 'bitcoin doubler',
];

/** Escapes a phrase for use inside a word-boundary regex. */
const phrasePattern = (phrase) =>
  new RegExp(`(?:^|\\W)${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|\\W)`, 'i');

const PHRASE_PATTERNS = SPAM_PHRASES.map((phrase) => [phrase, phrasePattern(phrase)]);

const countLinks = (text) => (String(text).match(LINK_PATTERN) || []).length;

/**
 * A submission's fingerprint for the duplicate check: the same person sending
 * the same words. Whitespace-insensitive, because a resubmitted form often
 * differs only by a trailing newline.
 */
const normalise = (text) => String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * @returns {Promise<{spam: boolean, reason?: string}>}
 */
const classify = async ({ name, email, message, honeypot, renderedAt, ipHash }, ContactMessage) => {
  // 1. Honeypot. A hidden field with a plausible name; a person never sees it.
  if (String(honeypot || '').trim()) return { spam: true, reason: 'honeypot' };

  // 2. Timing. `renderedAt` is stamped by the page when the form is drawn.
  //    Absent or unparseable is not held against the sender — an older cached
  //    page, or a client that strips it, must not be treated as a bot.
  const rendered = Number(renderedAt);
  if (Number.isFinite(rendered) && rendered > 0) {
    const elapsed = (Date.now() - rendered) / 1000;
    // A negative elapsed time means a clock skew, not a time traveller.
    if (elapsed >= 0 && elapsed < MIN_FILL_SECONDS) return { spam: true, reason: 'too_fast' };
  }

  // 3. Content.
  if (countLinks(message) > MAX_LINKS) return { spam: true, reason: 'too_many_links' };

  const haystack = `${normalise(name)} ${normalise(message)}`;
  const hit = PHRASE_PATTERNS.find(([, pattern]) => pattern.test(haystack));
  if (hit) return { spam: true, reason: `phrase:${hit[0]}` };

  // 4. Duplicate. The same words from the same sender, or from the same address
  //    on the network, inside the window.
  const since = new Date(Date.now() - DUPLICATE_WINDOW_MS);
  const recent = await ContactMessage.findAll({
    where: {
      created_at: { [Op.gte]: since },
      [Op.or]: [
        { email: String(email).toLowerCase() },
        ...(ipHash ? [{ ipHash }] : []),
      ],
    },
    attributes: ['message'],
    limit: 20,
    order: [['createdAt', 'DESC']],
  });

  const body = normalise(message);
  if (recent.some((row) => normalise(row.message) === body)) {
    return { spam: true, reason: 'duplicate' };
  }

  return { spam: false };
};

module.exports = {
  classify,
  MIN_FILL_SECONDS,
  DUPLICATE_WINDOW_MS,
  MAX_LINKS,
  SPAM_PHRASES,
};
