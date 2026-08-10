/**
 * The content categories a filter rule can name, and the domains each one
 * resolves to.
 *
 * A category rule used to be a promise nobody kept. `WebsiteRule` has always
 * accepted `{ category: 'adult', action: 'block' }` with no url, the family app
 * offers exactly that, and the device blocks by DNS name — so a parent could
 * switch on "adult" and the phone would receive nothing to block. Categories are
 * expanded here instead (see `utils/contentPolicy.js`), which is what makes a
 * category rule enforceable at all, on a child's rules and on the platform-wide
 * policy alike.
 *
 * The lists below are a seed, not a commercial feed. They cover the sites that
 * actually come up on a child's phone; they are not, and cannot be, exhaustive.
 * A domain covers its subdomains — the device matches `d === b || d.endsWith('.' + b)`
 * — so `youtube.com` is enough for `m.youtube.com` and `www.youtube.com`.
 *
 * `violence` is deliberately absent. It was in the family app's picker and no
 * DNS-level list can honour it: identifying violent content needs classification
 * of pages, which nothing in the platform does. Rules already stored under it
 * keep their label through LEGACY_CATEGORY_LABELS.
 */

const CONTENT_CATEGORIES = [
  {
    key: 'adult',
    label: 'Adult Content',
    description: 'Pornography, explicit imagery',
    domains: [
      'pornhub.com', 'xvideos.com', 'xnxx.com', 'xhamster.com', 'redtube.com',
      'youporn.com', 'onlyfans.com', 'chaturbate.com', 'stripchat.com',
      'adultfriendfinder.com', 'rule34.xxx', 'e-hentai.org', 'nhentai.net',
    ],
  },
  {
    key: 'gambling',
    label: 'Gambling',
    description: 'Betting, casinos, lotteries',
    domains: [
      'bet365.com', 'draftkings.com', 'fanduel.com', 'williamhill.com',
      'pokerstars.com', 'betway.com', 'bovada.lv', 'stake.com', 'roobet.com',
      'csgoempire.com', 'unibet.com', 'paddypower.com',
    ],
  },
  {
    key: 'social_media',
    label: 'Social Media',
    description: 'Facebook, Instagram, TikTok',
    domains: [
      'facebook.com', 'instagram.com', 'tiktok.com', 'snapchat.com', 'x.com',
      'twitter.com', 'reddit.com', 'tumblr.com', 'pinterest.com', 'threads.net',
      'discord.com', 'kik.com', 'ask.fm', 'omegle.com',
    ],
  },
  {
    key: 'gaming',
    label: 'Gaming',
    description: 'Online games, gaming portals',
    domains: [
      'roblox.com', 'fortnite.com', 'epicgames.com', 'steampowered.com',
      'minecraft.net', 'ea.com', 'battle.net', 'poki.com', 'crazygames.com',
      'miniclip.com', 'y8.com', 'itch.io', 'xbox.com', 'playstation.com',
    ],
  },
  {
    key: 'streaming',
    label: 'Streaming Media',
    description: 'Netflix, YouTube, Hulu',
    domains: [
      'netflix.com', 'youtube.com', 'hulu.com', 'disneyplus.com', 'twitch.tv',
      'primevideo.com', 'max.com', 'peacocktv.com', 'crunchyroll.com',
      'dailymotion.com', 'vimeo.com',
    ],
  },
  {
    key: 'file_sharing',
    label: 'File Sharing',
    description: 'Torrents, P2P networks',
    domains: [
      'thepiratebay.org', '1337x.to', 'rarbg.to', 'yts.mx', 'nyaa.si',
      'torrentgalaxy.to', 'limetorrents.lol', 'kickasstorrents.to',
      'mega.nz', 'mediafire.com', 'zippyshare.com',
    ],
  },
];

/** Labels for keys no longer offered, so a rule stored under one still reads. */
const LEGACY_CATEGORY_LABELS = {
  violence: 'Violence',
  custom: 'Custom',
};

const CATEGORY_KEYS = CONTENT_CATEGORIES.map((c) => c.key);

const CATEGORY_BY_KEY = Object.fromEntries(CONTENT_CATEGORIES.map((c) => [c.key, c]));

const categoryLabel = (key) =>
  CATEGORY_BY_KEY[key]?.label || LEGACY_CATEGORY_LABELS[key] || key;

/** The domains one category covers; `[]` for a key with no list behind it. */
const domainsForCategory = (key) => [...(CATEGORY_BY_KEY[key]?.domains || [])];

/**
 * Which category a domain belongs to, or null. Matched the same way the device
 * matches a rule, so `m.youtube.com` reports as Streaming Media rather than
 * falling through to "other".
 */
const categoryForDomain = (domain) => {
  const d = String(domain || '').toLowerCase().replace(/\.+$/, '');
  if (!d) return null;
  const hit = CONTENT_CATEGORIES.find((c) =>
    c.domains.some((base) => d === base || d.endsWith(`.${base}`)));
  return hit ? hit.key : null;
};

/** What the console and the family app need: no domain lists, just the labels. */
const categoryCatalogue = () => CONTENT_CATEGORIES.map(({ key, label, description, domains }) => ({
  key, label, description, domainCount: domains.length,
}));

module.exports = {
  CONTENT_CATEGORIES,
  CATEGORY_KEYS,
  LEGACY_CATEGORY_LABELS,
  categoryLabel,
  domainsForCategory,
  categoryForDomain,
  categoryCatalogue,
};
