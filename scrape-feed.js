#!/usr/bin/env node
/**
 * Gulf Briefing — Live Feed Scraper (RSS + GDELT)
 *
 * Two-tier scraper for the live feed page:
 *   Tier 1: RSS feeds from sources.json (Arabic + English outlets)
 *   Tier 2: GDELT DOC API (catches outlets without RSS — Asharq al-Awsat,
 *           Alriyadh, Okaz, and broader English-language Gulf coverage)
 *
 * No Playwright, no screenshots, no Claude API calls.
 * Designed to run every 15 min via GitHub Actions cron.
 *
 * Auto-translates Arabic headlines via Google Translate.
 * Merges with existing feed.json to preserve history across runs.
 *
 * Run: node scrape-feed.js
 * Output: feed.json
 */

const https = require('https');
const http = require('http');
const fs = require('fs');

const CONFIG_PATH = './sources.json';
const FEED_PATH = './feed.json';
// Match lib/scrape-twitter.js's default (300). Otherwise the 15-min RSS cron
// caps to 200 and drops ~100 tweets that the 3h twitter cron just merged in.
const MAX_ITEMS = 300;

// ============================================
// COUNTRY LABEL MAPPING
// Maps source categories to human-readable country names
// ============================================

const COUNTRY_MAP = {
  saudi: 'Saudi Arabia',
  saudi_twitter: 'Saudi Arabia',
  uae: 'UAE',
  uae_twitter: 'UAE',
  qatar: 'Qatar',
  qatar_twitter: 'Qatar',
  bahrain: 'Bahrain',
  bahrain_twitter: 'Bahrain',
  kuwait: 'Kuwait',
  oman: 'Oman',
  oman_twitter: 'Oman',
  yemen_irg: 'Yemen',
  yemen_irg_twitter: 'Yemen',
  yemen_houthi: 'Yemen',
  yemen_houthi_twitter: 'Yemen',
  yemen_stc: 'Yemen',
  yemen_stc_twitter: 'Yemen',
  wire: 'Wire',
  competitors: 'Wire',
  arabic_aggregate: 'Regional',
};

// ============================================
// FETCH (same as generate-briefing.js)
// ============================================

function fetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    // insecureHTTPParser tolerates sloppy server headers (WAM's API sends
    // malformed CR-after-header-value that strict parsing rejects). Safe for
    // read-only fetches; we're not in a security-critical context.
    const req = client.get(url, {
      insecureHTTPParser: true,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html, application/rss+xml, application/xml, text/xml',
        ...options.headers
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetch(res.headers.location, options).then(resolve).catch(reject);
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(options.timeout || 15000, () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
  });
}

// ============================================
// TRANSLATION (Google Translate API - free tier)
// ============================================

const HAS_ARABIC = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

async function translateText(text) {
  if (!text || text.length === 0) return text;
  // Google Translate's free tier has an unpublished char cap. Truncate defensively.
  const MAX_CHARS = 4800;
  let input = text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text;
  // String.slice() cuts at UTF-16 code units. Persian/Arabic/emoji can occupy
  // surrogate pairs (two code units). If we cut a pair in half, encodeURIComponent
  // throws URIError: URI malformed. Strip any trailing lone surrogate defensively.
  if (input.length > 0 && input.charCodeAt(input.length - 1) >= 0xD800 && input.charCodeAt(input.length - 1) <= 0xDBFF) {
    input = input.slice(0, -1);
  }
  let encoded;
  try {
    encoded = encodeURIComponent(input);
  } catch (e) {
    // Still malformed somehow — fall back to original untranslated text.
    return text;
  }
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=${encoded}`;
  try {
    const response = await fetch(url);
    const data = JSON.parse(response);
    if (data && data[0]) {
      return data[0].map(item => item[0]).join('');
    }
    return text;
  } catch (e) {
    return text;
  }
}

// ============================================
// HEADLINE CLEANING
// ============================================

// Headlines matching these patterns are noise for a Gulf news feed
const NOISE_PATTERNS = [
  // Sports
  /\b(IPL|cricket|wickets?|CSK|RCB|innings|T20|ODI|FIFA|World Cup|Premier League|La Liga|Serie A|Bundesliga|Champions League|UEFA|NBA|NFL|MLB|NHL|tennis|WTA|ATP|Grand Slam|Formula [1-9]|F1|MotoGP|golf|PGA|boxing|UFC|MMA)\b/i,
  // Weather
  /\b(weather forecast|temperature|humidity|sunny|cloudy|rainfall|thunderstorm|heat wave|cold front)\b/i,
  // Horoscopes, lifestyle fluff
  /\b(horoscope|zodiac|daily horoscope|tarot)\b/i,
];

function isNoise(headline) {
  return NOISE_PATTERNS.some(pattern => pattern.test(headline));
}

function cleanHeadline(text) {
  if (!text) return null;
  let h = text.trim().replace(/\s+/g, ' ');
  h = h.replace(/^\d+\s*min\s*(read|listen)/i, '').trim();
  h = h.replace(/\d+\s*min\s*(read|listen)$/i, '').trim();
  if (h.length < 10 || h.length > 300) return null;
  if (isNoise(h)) return null;
  return h;
}

// ============================================
// RSS PARSER
// ============================================

function parseRSS(xml, source) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;

  while ((match = itemRegex.exec(xml)) !== null && items.length < 15) {
    const itemXml = match[1];
    const title = (itemXml.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) ||
                   itemXml.match(/<title>(.*?)<\/title>/))?.[1]?.trim();
    const link = (itemXml.match(/<link><!\[CDATA\[(.*?)\]\]><\/link>/) ||
                  itemXml.match(/<link>(.*?)<\/link>/) ||
                  itemXml.match(/<link[^>]*href="([^"]+)"/))?.[1]?.trim();
    const pubDate = (itemXml.match(/<pubDate>(.*?)<\/pubDate>/))?.[1]?.trim();

    const headline = cleanHeadline(title?.replace(/<[^>]*>/g, ''));
    if (headline && link) {
      items.push({
        headline,
        url: link,
        source: source.name,
        sourceId: source.id,
        category: source.category || 'general',
        country: COUNTRY_MAP[source.category] || 'Other',
        language: source.language || 'en',
        date: pubDate ? new Date(pubDate).toISOString() : new Date().toISOString()
      });
    }
  }

  // Try Atom format if RSS didn't find anything
  if (items.length === 0) {
    const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
    while ((match = entryRegex.exec(xml)) !== null && items.length < 15) {
      const entryXml = match[1];
      const title = (entryXml.match(/<title[^>]*>(.*?)<\/title>/))?.[1]?.trim();
      const link = (entryXml.match(/<link[^>]*href="([^"]+)"/))?.[1]?.trim();
      const updated = (entryXml.match(/<updated>(.*?)<\/updated>/))?.[1]?.trim();

      const headline = cleanHeadline(title?.replace(/<[^>]*>/g, ''));
      if (headline && link) {
        items.push({
          headline,
          url: link,
          source: source.name,
          sourceId: source.id,
          category: source.category || 'general',
          country: COUNTRY_MAP[source.category] || 'Other',
          language: source.language || 'en',
          date: updated ? new Date(updated).toISOString() : new Date().toISOString()
        });
      }
    }
  }

  return items;
}

// ============================================
// GDELT DOC API
// Fetches Gulf-related articles from GDELT's global media index.
// Catches outlets without RSS (Asharq al-Awsat, Alriyadh, Okaz)
// and broader English-language Gulf coverage.
//
// Rate limit: ~5s between requests (GDELT enforces this).
// API is free, no auth needed.
// ============================================

const GDELT_BASE = 'https://api.gdeltproject.org/api/v2/doc/doc';

// FIPS country codes → human-readable names
const FIPS_MAP = {
  SA: 'Saudi Arabia',
  AE: 'UAE',
  QA: 'Qatar',
  KW: 'Kuwait',
  BA: 'Bahrain',  // GDELT uses BA for Bahrain
  MU: 'Oman',     // GDELT FIPS for Oman
  YM: 'Yemen',
  JO: 'Jordan',
  IZ: 'Iraq',
  IR: 'Iran',
  IS: 'Israel',
  TU: 'Turkey',
  EG: 'Egypt',
  LE: 'Lebanon',
};

// GDELT queries: one for Arabic outlets in Gulf countries, one for English quality outlets
const GDELT_QUERIES = [
  {
    label: 'Gulf Arabic outlets',
    // Search Arabic-language articles from Gulf countries about Gulf topics
    query: '(domain:aawsat.com OR domain:alriyadh.com OR domain:okaz.com.sa OR domain:alarabiya.net OR domain:spa.gov.sa OR domain:arabic.cnn.com OR domain:aljazeera.net)',
    params: 'mode=artlist&maxrecords=50&format=json&sort=datedesc',
  },
  {
    label: 'Gulf English wire',
    // English-language articles about Gulf from quality outlets
    query: '(Saudi OR UAE OR Qatar OR Kuwait OR Bahrain OR Oman OR Yemen OR Houthi OR Hormuz OR Aramco) (domain:reuters.com OR domain:wsj.com OR domain:ft.com OR domain:theguardian.com OR domain:bbc.com OR domain:english.aawsat.com)',
    params: 'mode=artlist&maxrecords=50&format=json&sort=datedesc',
  },
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Parse GDELT's JSON artlist response into our feed item format
function parseGdeltResponse(json, queryLabel) {
  const items = [];
  if (!json || !json.articles) return items;

  for (const article of json.articles) {
    const headline = cleanHeadline(article.title);
    if (!headline || !article.url) continue;

    // Map GDELT domain to a source name
    const domain = article.domain || '';
    const sourceName = gdeltDomainToSource(domain);

    // Map FIPS country code to country name
    // Try to infer country from domain if GDELT doesn't provide it
    const country = FIPS_MAP[article.sourcecountry] || inferCountryFromDomain(domain) || 'Regional';

    // Parse GDELT date format: "20260330T173000Z"
    let date;
    try {
      const d = article.seendate || '';
      date = new Date(
        d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8) + 'T' +
        d.slice(9, 11) + ':' + d.slice(11, 13) + ':' + d.slice(13, 15) + 'Z'
      ).toISOString();
    } catch (e) {
      date = new Date().toISOString();
    }

    // Skip items with CJK/Cyrillic text (noise from GDELT's broad matching)
    const hasCJK = /[\u3000-\u9FFF\uAC00-\uD7AF]/.test(headline);
    const hasCyrillic = /[\u0400-\u04FF]/.test(headline);
    if (hasCJK || hasCyrillic) continue;

    items.push({
      headline,
      url: article.url,
      source: sourceName,
      sourceId: 'gdelt_' + domain.replace(/\./g, '_'),
      category: 'gdelt',
      country,
      language: article.language === 'Arabic' ? 'ar' : 'en',
      date,
      tier: 'gdelt',
    });
  }

  return items;
}

// Map GDELT domains to readable source names
function gdeltDomainToSource(domain) {
  const map = {
    'english.aawsat.com': 'Asharq al-Awsat (EN)',
    'aawsat.com': 'Asharq al-Awsat',
    'alriyadh.com': 'Alriyadh',
    'okaz.com.sa': 'Okaz',
    'spa.gov.sa': 'Saudi Press Agency',
    'arabic.cnn.com': 'CNN Arabic',
    'aljazeera.net': 'Al Jazeera Arabic',
    'alarabiya.net': 'Al Arabiya',
    'reuters.com': 'Reuters',
    'wsj.com': 'WSJ',
    'ft.com': 'Financial Times',
    'theguardian.com': 'The Guardian',
    'bbc.com': 'BBC',
    'bbc.co.uk': 'BBC',
  };
  return map[domain] || domain;
}

// Infer country from domain when GDELT doesn't tag it
function inferCountryFromDomain(domain) {
  if (domain.endsWith('.sa') || domain.includes('alarabiya') || domain.includes('aawsat')) return 'Saudi Arabia';
  if (domain.endsWith('.ae')) return 'UAE';
  if (domain.endsWith('.qa') || domain.includes('aljazeera')) return 'Qatar';
  if (domain.endsWith('.kw')) return 'Kuwait';
  if (domain.endsWith('.bh')) return 'Bahrain';
  if (domain.endsWith('.om')) return 'Oman';
  if (domain.endsWith('.ye')) return 'Yemen';
  return null;
}

async function fetchGdelt() {
  const allItems = [];

  for (let i = 0; i < GDELT_QUERIES.length; i++) {
    const q = GDELT_QUERIES[i];
    const url = `${GDELT_BASE}?query=${encodeURIComponent(q.query)}&${q.params}`;

    try {
      // GDELT rate limit: ~5 min cooldown between requests.
      // Wait 6s between our own requests; if we get rate-limited, retry after 60s.
      // With a 15-min cron cycle, 2 queries + 1 retry fits comfortably.
      if (i > 0) {
        console.log('  (waiting 6s between GDELT requests...)');
        await sleep(6000);
      }

      const response = await fetch(url);

      // GDELT returns plain text errors when rate-limited or on bad queries
      if (response.startsWith('Please lim') || response.startsWith('Invalid') || response.startsWith('<!')) {
        console.log(`  X  GDELT: ${q.label}: rate limited or invalid query`);
        // GDELT enforces ~5 min between requests when rate-limited.
        // In a 15-min cron, we can afford one retry with a long wait.
        console.log('  (waiting 60s and retrying...)');
        await sleep(60000);
        const retry = await fetch(url);
        if (retry.startsWith('Please') || retry.startsWith('Invalid') || retry.startsWith('<!')) {
          console.log(`  X  GDELT: ${q.label}: still rate limited, skipping`);
          continue;
        }
        const retryData = JSON.parse(retry);
        const retryItems = parseGdeltResponse(retryData, q.label);
        console.log(`  OK GDELT: ${q.label} (${retryItems.length}) [retry]`);
        allItems.push(...retryItems);
        continue;
      }

      const data = JSON.parse(response);
      const items = parseGdeltResponse(data, q.label);
      console.log(`  OK GDELT: ${q.label} (${items.length})`);
      allItems.push(...items);
    } catch (e) {
      console.log(`  X  GDELT: ${q.label}: ${e.message}`);
    }
  }

  return allItems;
}

// ============================================
// SPA JSON API (Saudi Press Agency)
// SPA's site has no working RSS, but its frontend hits a public JSON API at
// portalapi.spa.gov.sa. Each item has title/sharable_link/published_at and we
// shape those into feed.json items. Pulls Arabic content (more complete than
// English); translation happens in the main loop's existing translateText pass.
//
// Per-source config: source.categories = [1, 2, 3, 17] etc. — see
// /api/v1/categories?l=en for the full list.
// ============================================

async function fetchSpaApi(source) {
  const items = [];
  const categories = source.categories || [1];
  for (const catId of categories) {
    // per_page=50: GH Actions cron throttles to ~3-4hr gaps in practice, so a
    // single category can accumulate 15+ items between runs. 10 was dropping
    // older items silently. 50 gives ~3hr headroom even on busy news days.
    const perPage = source.perPage || 50;
    const apiUrl = `${source.url}?per_page=${perPage}&category_id=${catId}&l=ar`;
    try {
      const res = await fetch(apiUrl, { headers: { 'Accept': 'application/json' } });
      const data = JSON.parse(res);
      for (const apiItem of (data.data || [])) {
        // sharable_link comes back without protocol, e.g. "www.spa.gov.sa/N123?..."
        let url = apiItem.sharable_link || '';
        if (!url) continue;
        if (!url.startsWith('http')) url = `https://${url}`;
        items.push({
          headline: (apiItem.title || '').trim(),
          url,
          source: source.name,
          sourceId: source.id,
          category: source.category || 'saudi',
          country: COUNTRY_MAP[source.category] || 'Saudi Arabia',
          language: source.language || 'ar',
          date: apiItem.published_at ? new Date(apiItem.published_at * 1000).toISOString() : new Date().toISOString(),
        });
      }
    } catch (e) {
      console.log(`  X  ${source.name} cat=${catId}: ${e.message}`);
    }
  }
  return items;
}

// ============================================
// WAM JSON API (Emirates News Agency)
// WAM exposes a structured "view" API: GetViewByUrl?url=en/home/main returns
// 11 sections each with articlesResult.items. We dedupe by article id across
// sections and shape into feed items. URLs are constructed from urlSlug.
// ============================================

async function fetchWamApi(source) {
  const items = [];
  const seen = new Set();
  // The API path; can be overridden in sources.json via source.viewPath.
  const viewPath = source.viewPath || 'en/home/main';
  const apiUrl = `${source.url}?url=${viewPath}`;
  try {
    const res = await fetch(apiUrl, { headers: { 'Accept': 'application/json' } });
    const data = JSON.parse(res);
    const sections = data.sections || [];
    for (const section of sections) {
      const sectionTitle = (section.displayTitle || '').toLowerCase();
      // Skip "most read" / "most widely traded" — they duplicate other sections.
      // Skip pure media (videos) and sports/culture; lower-priority categories
      // can be enabled later by tweaking source.skipSections.
      if (/most read|most widely|video|sports|culture/i.test(sectionTitle)) continue;
      const sectionItems = section.articlesResult?.items || [];
      for (const it of sectionItems) {
        if (!it.id || seen.has(it.id)) continue;
        seen.add(it.id);
        const slug = it.urlSlug || it.shortCode || '';
        if (!slug) continue;
        const url = `https://www.wam.ae/${viewPath.startsWith('ar') ? 'ar' : 'en'}/details/${slug}`;
        items.push({
          headline: (it.title || '').trim(),
          url,
          source: source.name,
          sourceId: source.id,
          category: source.category || 'uae',
          country: COUNTRY_MAP[source.category] || 'UAE',
          language: source.language || 'en',
          date: it.articleDate ? new Date(it.articleDate).toISOString() : new Date().toISOString(),
        });
      }
    }
  } catch (e) {
    console.log(`  X  ${source.name}: ${e.message}`);
  }
  return items;
}

// ============================================
// MAIN
// ============================================

async function main() {
  console.log('Gulf Feed Scraper (RSS + GDELT)');
  console.log(new Date().toISOString());
  console.log('');

  // ---- Tier 1: RSS feeds ----
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const rssSources = config.sources.filter(s => s.type === 'rss' && !s._comment);

  console.log(`Fetching ${rssSources.length} RSS feeds...`);

  const rssResults = await Promise.all(rssSources.map(async (source) => {
    try {
      const xml = await fetch(source.url);
      const stories = parseRSS(xml, source);
      console.log(`  OK ${source.name} (${stories.length})`);
      return stories;
    } catch (e) {
      console.log(`  X  ${source.name}: ${e.message}`);
      return [];
    }
  }));

  let allItems = rssResults.flat();
  console.log(`\nRSS items: ${allItems.length}`);

  // ---- Tier 2: GDELT ----
  console.log('\nFetching GDELT...');
  const gdeltItems = await fetchGdelt();
  allItems.push(...gdeltItems);
  console.log(`GDELT items: ${gdeltItems.length}`);

  // ---- Tier 3: State news agency JSON APIs ----
  // Each agency has its own response shape, hence per-agency adapters.
  // Pattern: discover the JSON endpoint from the live site (probe-agencies.js
  // is a good template), then add an adapter here.
  const spaSources = config.sources.filter(s => s.type === 'spa_api' && !s._comment);
  if (spaSources.length > 0) {
    console.log('\nFetching SPA API...');
    for (const source of spaSources) {
      const items = await fetchSpaApi(source);
      console.log(`  OK ${source.name}: ${items.length} items across ${(source.categories || [1]).length} categories`);
      allItems.push(...items);
    }
  }

  const wamSources = config.sources.filter(s => s.type === 'wam_api' && !s._comment);
  if (wamSources.length > 0) {
    console.log('\nFetching WAM API...');
    for (const source of wamSources) {
      const items = await fetchWamApi(source);
      console.log(`  OK ${source.name}: ${items.length} items`);
      allItems.push(...items);
    }
  }

  console.log(`Total raw items: ${allItems.length}`);

  // ---- Translate Arabic headlines ----
  let translated = 0;
  for (const item of allItems) {
    if (HAS_ARABIC.test(item.headline)) {
      item.originalHeadline = item.headline;
      item.headline = await translateText(item.headline);
      translated++;
    }
  }
  if (translated > 0) {
    console.log(`Translated ${translated} Arabic headlines`);
  }

  // ---- Merge with existing feed.json (preserve history) ----
  let existing = [];
  if (fs.existsSync(FEED_PATH)) {
    try {
      const prev = JSON.parse(fs.readFileSync(FEED_PATH, 'utf8'));
      existing = prev.items || [];
    } catch (e) {
      // Corrupted feed.json, start fresh
    }
  }

  // Merge: new items first, then existing. Dedup by URL.
  const seen = new Set();
  const merged = [];
  for (const item of [...allItems, ...existing]) {
    if (!seen.has(item.url)) {
      seen.add(item.url);
      merged.push(item);
    }
  }

  // Sort by date (newest first), cap at MAX_ITEMS
  merged.sort((a, b) => new Date(b.date) - new Date(a.date));
  const final = merged.slice(0, MAX_ITEMS);

  // Write feed.json
  const feed = {
    updated: new Date().toISOString(),
    itemCount: final.length,
    items: final
  };
  fs.writeFileSync(FEED_PATH, JSON.stringify(feed, null, 2));

  console.log(`\nWrote feed.json: ${final.length} items`);
  console.log('Done');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
