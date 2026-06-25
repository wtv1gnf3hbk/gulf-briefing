#!/usr/bin/env node
/**
 * scrape-twitter.js — shared briefing-toolkit module
 * ============================================================================
 *
 * Scrapes public X.com profile pages for the latest tweets and merges them
 * into a feed.json. Engineered for the briefing repos (gulf-briefing,
 * japan-briefing, afpak-briefing, dach-digest, iran-briefing, etc).
 *
 * USE FROM ANOTHER BRIEFING:
 *   1. Copy this file to <your-briefing>/lib/scrape-twitter.js
 *      (or curl from gulf-briefing/main at workflow runtime)
 *   2. In your generate-briefing.js (or a thin scrape-twitter.js wrapper):
 *
 *      const { runTwitterOnly } = require('./lib/scrape-twitter');
 *      runTwitterOnly({
 *        sources: config.sources.filter(s => s.type === 'twitter'),
 *        countryMap: COUNTRY_MAP,           // your briefing's category → country
 *        feedPath: './feed.json',
 *        maxItems: 300,
 *      });
 *
 * REQUIREMENTS:
 *   - playwright in package.json + chromium installed
 *   - feed.json (created if missing)
 *
 * KEY HARD-WON LESSONS (don't undo these):
 *
 *   1. **Never click X's native "Translate post" button before extracting.**
 *      It re-renders the article and pulls <time> out of its parent <a>,
 *      destroying the permalink. Translation runs after via Google Translate
 *      API in translateTweets(). See gulf-briefing 2026-04-27 outage.
 *
 *   2. **Skip pinned tweets.** Their socialContext label says "Pinned" — they
 *      pollute "latest activity" with old content. Detection via
 *      [data-testid="socialContext"].
 *
 *   3. **Always have a syndication fallback.** When x.com forces a login wall
 *      (CI runner IPs sometimes get bot-flagged), syndication.twitter.com
 *      still serves embed-format profile timelines. Lower-fidelity but
 *      better than zero.
 *
 *   4. **Drop tweets that lack permalinks, don't paper over.** Pushing items
 *      with profile-URL fallbacks pollutes feed.json's URL-dedup. Better to
 *      log "extracted N, merged 0" so we can see the regression.
 *
 *   5. **Sanity-warn on coverage drop.** If <50% of attempted handles
 *      produce items, log a WARNING — this catches X DOM changes.
 *
 * ============================================================================
 */

const https = require('https');
const fs = require('fs');

// Lazy require playwright so the module loads even when chromium is missing
// (e.g., for unit testing helpers like tweetsToFeedItems).
let _playwright = null;
function getPlaywright() {
  if (!_playwright) _playwright = require('playwright');
  return _playwright;
}

// ============================================
// FETCH (used by translateText)
// ============================================

function fetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        ...options.headers,
      },
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
// TRANSLATION (Google free-tier gateway, no API key)
// ============================================

async function translateText(text, targetLang = 'en') {
  if (!text || text.length === 0) return text;
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${targetLang}&dt=t&q=${encodeURIComponent(text)}`;
  try {
    const response = await fetch(url);
    const data = JSON.parse(response);
    if (data && data[0]) {
      return data[0].map(item => item[0]).join('');
    }
    return text;
  } catch (e) {
    return text; // Translation failed, return original
  }
}

// Detect text that needs translation. Covers Arabic, Persian/Farsi, Urdu, Pashto,
// Hebrew, Japanese, Korean, simplified+traditional Chinese, Thai, Cyrillic.
// (Briefings can always pass their own predicate via opts.shouldTranslate.)
const NON_LATIN_RE = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿֐-׿぀-ゟ゠-ヿ一-鿿가-힯฀-๿Ѐ-ӿ]/;

async function translateTweets(tweets, shouldTranslate = (t) => NON_LATIN_RE.test(t)) {
  if (!tweets || tweets.length === 0) return tweets;
  const out = [];
  for (const tweet of tweets) {
    const text = typeof tweet === 'string' ? tweet : tweet.text;
    if (text && shouldTranslate(text)) {
      const translated = await translateText(text);
      if (typeof tweet === 'string') {
        out.push(translated);
      } else {
        out.push({ ...tweet, text: translated, originalText: text });
      }
    } else {
      out.push(tweet);
    }
  }
  return out;
}

// ============================================
// BROWSER LIFECYCLE
// ============================================

let _browser = null;

// ============================================
// AUTHENTICATED SESSION (Option B)
// X killed free unauthenticated profile-timeline access (~June 2026): both the
// logged-out x.com page and the syndication endpoints now return a login wall /
// empty. The only reliable read path is a logged-in session. We inject an
// X account's session cookies (from env / GH secret) into the browser context
// so the existing x.com extraction renders real timelines.
//
// Secrets (set as GH Actions secrets + local .env):
//   X_AUTH_TOKEN — the `auth_token` cookie from a logged-in x.com session
//   X_CT0        — the `ct0` (CSRF) cookie (recommended; some endpoints need it)
//
// Get them: log into x.com in a browser → DevTools → Application → Cookies →
// copy `auth_token` and `ct0`. They expire periodically; refresh when coverage
// drops to zero again. Use a throwaway/burner account — there is a small ban risk.
function getAuthCookies() {
  const authToken = process.env.X_AUTH_TOKEN;
  const ct0 = process.env.X_CT0;
  if (!authToken) return null;
  const cookies = [];
  for (const domain of ['.x.com', '.twitter.com']) {
    cookies.push({ name: 'auth_token', value: authToken, domain, path: '/', httpOnly: true, secure: true, sameSite: 'None' });
    if (ct0) cookies.push({ name: 'ct0', value: ct0, domain, path: '/', secure: true, sameSite: 'Lax' });
  }
  return cookies;
}

// True when an authenticated session is configured. Callers use this to decide
// whether a zero-tweet run is "expected, not wired up" vs "broken, alert".
function hasAuthSession() {
  return !!process.env.X_AUTH_TOKEN;
}

async function initBrowser() {
  if (_browser) return _browser;
  try {
    const { chromium } = getPlaywright();
    _browser = await chromium.launch({ headless: true });
    return _browser;
  } catch (e) {
    console.error('Failed to launch chromium:', e.message);
    return null;
  }
}

async function closeBrowser() {
  if (_browser) {
    await _browser.close().catch(() => {});
    _browser = null;
  }
}

// ============================================
// X.COM EXTRACTION (primary path)
// ============================================

async function extractTweetsFromXPage(page, maxTweets = 5) {
  // INTENTIONALLY NOT clicking the "Translate post" button — it re-renders the
  // article and breaks the <time> → <a> permalink relationship. We translate
  // ourselves below via translateTweets().
  return await page.evaluate((maxTweets) => {
    const results = [];
    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    for (const article of articles) {
      // Skip pinned tweets — they're old content posing as latest activity.
      const social = article.querySelector('[data-testid="socialContext"]');
      if (social && /pinned/i.test(social.textContent || '')) continue;

      const textEl = article.querySelector('[data-testid="tweetText"]');
      const text = textEl?.innerText?.trim();
      if (!text) continue;

      const timeEl = article.querySelector('time[datetime]');
      const timestamp = timeEl?.getAttribute('datetime') || null;

      // Permalink = the <a> wrapping <time>. Canonicalize to strip /photo/N,
      // /analytics, etc. Accept relative or absolute hrefs.
      const linkEl = timeEl ? timeEl.closest('a[href*="/status/"]') : article.querySelector('a[href*="/status/"]');
      const href = linkEl?.getAttribute('href') || '';
      const m = href.match(/(?:https?:\/\/x\.com)?(\/[^/]+\/status\/\d+)/);
      const permalink = m ? `https://x.com${m[1]}` : null;

      // Author handle (nice-to-have, e.g. for retweets where it differs from
      // the source profile we're scraping).
      const authorEl = article.querySelector('[data-testid="User-Name"] a');
      const authorHandle = authorEl?.getAttribute('href') || null;

      results.push({ text, timestamp, permalink, authorHandle });
      if (results.length >= maxTweets) break;
    }
    return results;
  }, maxTweets);
}

// ============================================
// SYNDICATION FALLBACK
// X.com sometimes serves a login wall to headless / CI IPs. The syndication
// endpoint (used by embed widgets) usually doesn't, though it returns less
// metadata. Lower-fidelity but better than zero.
// ============================================

function detectLoginWall(bodyText) {
  return /Log in to X|Sign up to|Sign in to|Something went wrong/i.test(bodyText)
    && !bodyText.includes('@');
}

async function extractTweetsFromSyndication(page, handle, maxTweets = 5) {
  const url = `https://syndication.twitter.com/srv/timeline-profile/screen-name/${handle}?with_replies=true&dnt=true`;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    return await page.evaluate((handle, maxTweets) => {
      const results = [];
      // Syndication renders tweets inside <article> or div with "Tweet" class
      const articles = document.querySelectorAll('article, div[class*="Tweet"]');
      for (const article of articles) {
        if (results.length >= maxTweets) break;
        const text = article.innerText?.trim();
        if (!text || text.length < 10) continue;
        const timeEl = article.querySelector('time');
        const timestamp = timeEl?.getAttribute('datetime') || null;
        // Syndication links are full URLs; try to extract a status link
        const linkEl = article.querySelector('a[href*="/status/"]');
        const href = linkEl?.getAttribute('href') || '';
        const m = href.match(/^https?:\/\/(?:twitter\.com|x\.com)(\/[^/]+\/status\/\d+)/);
        const permalink = m ? `https://x.com${m[1]}` : null;
        results.push({
          text: text.split('\n')[0],
          timestamp,
          permalink,
          via: 'syndication',
        });
      }
      return results;
    }, handle, maxTweets);
  } catch (e) {
    return [];
  }
}

// ============================================
// PER-HANDLE SCRAPE (orchestrates x.com + fallback + translate)
// ============================================

async function scrapeOneHandle(source, opts = {}) {
  const { maxTweetsPerHandle = 5 } = opts;
  const browser = await initBrowser();
  if (!browser) {
    return { ...source, tweets: [], error: 'Browser not available' };
  }

  let page;
  try {
    page = await browser.newPage();
    await page.setViewportSize({ width: 600, height: 900 });

    // Inject the logged-in X session (Option B) so x.com renders real timelines
    // instead of a login wall. No-op when X_AUTH_TOKEN isn't set — falls through
    // to the (now usually empty) logged-out path + syndication fallback.
    const authCookies = getAuthCookies();
    if (authCookies) {
      try { await page.context().addCookies(authCookies); }
      catch (e) { console.error(`  (auth cookie injection failed: ${e.message})`); }
    }

    await page.goto(source.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(5000);

    const bodyText = await page.evaluate(() => document.body?.innerText || '');
    const wall = detectLoginWall(bodyText);

    let tweets = [];
    if (!wall) {
      try { tweets = await extractTweetsFromXPage(page, maxTweetsPerHandle); }
      catch (e) { /* fall through to syndication */ }
    }

    // Fallback to syndication if x.com gave us nothing
    if (tweets.length === 0) {
      const handle = source.url.split('/').filter(Boolean).pop();
      tweets = await extractTweetsFromSyndication(page, handle, maxTweetsPerHandle);
    }

    if (tweets.length > 0) {
      tweets = await translateTweets(tweets, opts.shouldTranslate);
    }

    return { ...source, tweets, error: null, viaWall: wall };
  } catch (e) {
    return { ...source, tweets: [], error: e.message };
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

// ============================================
// SHAPE INTO feed.json ITEMS
// Each tweet becomes a feed item matching scrape-feed.js's shape:
// { headline, url, source, sourceId, category, country, language, date, originalHeadline? }
// ============================================

function tweetsToFeedItems(results, countryMap = {}) {
  const items = [];
  const drops = [];
  for (const source of results) {
    if (source.error || !source.tweets) continue;
    const extracted = source.tweets.length;
    const before = items.length;
    for (const tweet of source.tweets) {
      const text = typeof tweet === 'string' ? tweet : tweet.text;
      const permalink = typeof tweet === 'object' ? tweet.permalink : null;
      const timestamp = typeof tweet === 'object' ? tweet.timestamp : null;
      const originalText = typeof tweet === 'object' ? tweet.originalText : null;
      if (!permalink || !text) continue;
      items.push({
        headline: text.slice(0, 280),
        url: permalink,
        source: source.name,
        sourceId: source.id,
        category: source.category,
        country: countryMap[source.category] || null,
        language: source.language || 'en',
        date: timestamp || new Date().toISOString(),
        ...(originalText ? { originalHeadline: originalText.slice(0, 280) } : {}),
      });
    }
    if (extracted > 0 && items.length === before) {
      drops.push(`${source.name} (${source.id}): extracted ${extracted}, merged 0 — likely missing permalinks`);
    }
  }
  if (drops.length > 0) {
    console.log(`\n!! WARNING: ${drops.length} source(s) had all tweets dropped:`);
    for (const d of drops) console.log(`     ${d}`);
  }
  return items;
}

// ============================================
// MERGE INTO feed.json (URL-dedup, newest-first, capped)
// Mirrors scrape-feed.js's merge logic.
// ============================================

function mergeTweetsIntoFeed(newItems, opts = {}) {
  const { feedPath = './feed.json', maxItems = 300 } = opts;
  let existing = [];
  if (fs.existsSync(feedPath)) {
    try {
      const prev = JSON.parse(fs.readFileSync(feedPath, 'utf8'));
      existing = prev.items || [];
    } catch (e) { /* corrupted, start fresh */ }
  }
  const seen = new Set();
  const merged = [];
  for (const item of [...newItems, ...existing]) {
    if (!seen.has(item.url)) {
      seen.add(item.url);
      merged.push(item);
    }
  }
  merged.sort((a, b) => new Date(b.date) - new Date(a.date));
  const final = merged.slice(0, maxItems);
  const feed = {
    updated: new Date().toISOString(),
    itemCount: final.length,
    items: final,
  };
  fs.writeFileSync(feedPath, JSON.stringify(feed, null, 2));
  return { added: newItems.length, total: final.length };
}

// ============================================
// TOP-LEVEL ENTRY POINT
// Runs the full twitter-only flow. Returns {items, walls, dropped} for
// callers that want to do their own logging.
// ============================================

async function runTwitterOnly({ sources, countryMap = {}, feedPath = './feed.json', maxItems = 300, shouldTranslate, maxTweetsPerHandle = 5 }) {
  const startTime = Date.now();
  console.log(`Scraping ${sources.length} Twitter sources...\n`);

  const results = [];
  for (const source of sources) {
    const r = await scrapeOneHandle(source, { shouldTranslate, maxTweetsPerHandle });
    results.push(r);
    const tweetCount = (r.tweets || []).length;
    const tag = r.viaWall ? ' [via syndication / login wall]'
              : (r.tweets || []).some(t => t.via === 'syndication') ? ' [via syndication]'
              : '';
    if (r.error) console.log(`  X ${source.name}: ${r.error}`);
    else console.log(`  OK ${source.name} (${tweetCount} tweets)${tag}`);
  }
  await closeBrowser();

  const items = tweetsToFeedItems(results, countryMap);
  const { added, total } = mergeTweetsIntoFeed(items, { feedPath, maxItems });
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // Coverage sanity check
  const attempted = results.filter(r => !r.error).length;
  const producing = new Set(items.map(i => i.sourceId)).size;
  const ratio = attempted > 0 ? producing / attempted : 0;
  console.log(`\nAdded ${added} tweet items; feed.json now has ${total} items`);
  console.log(`Coverage: ${producing}/${attempted} handles produced items (${(ratio*100).toFixed(0)}%)`);
  if (attempted >= 10 && ratio < 0.5) {
    console.log(`!! WARNING: less than half of attempted handles produced feed items.`);
    console.log(`   Likely causes: X selector regression, login wall, expired/missing X auth, or rate limiting.`);
    if (!hasAuthSession()) {
      console.log(`   No X_AUTH_TOKEN configured — the logged-out scrape path is blocked by X.`);
      console.log(`   Set X_AUTH_TOKEN (+ X_CT0) to restore tweet coverage. See lib/scrape-twitter.js.`);
    }
  }
  console.log(`Time: ${elapsed}s`);

  // Total wipeout across a meaningful number of handles = broken, not a blip.
  // Surface it so the caller can fail the run red (Option D) instead of the
  // old silent "OK (0 tweets)" green that let this rot for 8 days unnoticed.
  const totalWipeout = attempted >= 10 && producing === 0;
  return { items, results, added, total, attempted, producing, ratio, totalWipeout };
}

// ============================================
// EXPORTS
// ============================================

module.exports = {
  // Top-level
  runTwitterOnly,
  // Building blocks (for callers that want custom flows)
  scrapeOneHandle,
  extractTweetsFromXPage,
  extractTweetsFromSyndication,
  detectLoginWall,
  translateText,
  translateTweets,
  tweetsToFeedItems,
  mergeTweetsIntoFeed,
  initBrowser,
  closeBrowser,
  getAuthCookies,
  hasAuthSession,
};
