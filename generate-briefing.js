#!/usr/bin/env node
/**
 * Gulf Briefing — Config-driven news scraper
 *
 * Reads sources from sources.json and scrapes them in parallel.
 * Supports: rss, screenshot, twitter
 * Translates Arabic content to English via Google Translate API.
 *
 * Run: node generate-briefing.js
 * Output: briefing.json + screenshots/ folder
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ============================================
// CONFIGURATION
// ============================================

const CONFIG_PATH = './sources.json';
const SCREENSHOTS_DIR = './screenshots';

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`Config file not found: ${CONFIG_PATH}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

// ============================================
// FETCH UTILITIES
// ============================================

function fetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html, application/rss+xml, application/xml, text/xml',
        ...options.headers
      }
    }, (res) => {
      // Follow redirects
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
// Translates Arabic text to English for the briefing.
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

async function translateTweets(tweets) {
  if (!tweets || tweets.length === 0) return tweets;

  const translated = [];
  for (const tweet of tweets) {
    // Check if tweet contains Arabic characters
    const hasArabic = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(tweet);
    if (hasArabic) {
      const translatedText = await translateText(tweet);
      translated.push(translatedText);
    } else {
      translated.push(tweet);
    }
  }
  return translated;
}

// ============================================
// HEADLINE CLEANING
// ============================================

function cleanHeadline(text) {
  if (!text) return null;
  let h = text.trim().replace(/\s+/g, ' ');
  h = h.replace(/^\d+\s*min\s*(read|listen)/i, '').trim();
  h = h.replace(/\d+\s*min\s*(read|listen)$/i, '').trim();
  return (h.length >= 10 && h.length <= 300) ? h : null;
}

// ============================================
// RSS PARSER
// ============================================

function parseRSS(xml, source) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;

  while ((match = itemRegex.exec(xml)) !== null && items.length < 10) {
    const itemXml = match[1];
    const title = (itemXml.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) ||
                   itemXml.match(/<title>(.*?)<\/title>/))?.[1]?.trim();
    const link = (itemXml.match(/<link><!\[CDATA\[(.*?)\]\]><\/link>/) ||
                  itemXml.match(/<link>(.*?)<\/link>/) ||
                  itemXml.match(/<link[^>]*href="([^"]+)"/))?.[1]?.trim();
    const description = (itemXml.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/) ||
                        itemXml.match(/<description>(.*?)<\/description>/))?.[1]?.trim();
    const pubDate = (itemXml.match(/<pubDate>(.*?)<\/pubDate>/))?.[1]?.trim();

    const headline = cleanHeadline(title?.replace(/<[^>]*>/g, ''));
    if (headline && link) {
      items.push({
        headline,
        url: link,
        source: source.name,
        sourceId: source.id,
        category: source.category || 'general',
        priority: source.priority || 'secondary',
        date: pubDate || null,
        description: description ? description.replace(/<[^>]*>/g, '').trim().slice(0, 200) : ''
      });
    }
  }

  // Try Atom format if RSS didn't find anything
  if (items.length === 0) {
    const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
    while ((match = entryRegex.exec(xml)) !== null && items.length < 10) {
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
          priority: source.priority || 'secondary',
          date: updated || null,
          description: ''
        });
      }
    }
  }

  return items;
}

// ============================================
// GOOGLE NEWS URL RESOLVER
// Google News RSS returns opaque redirect URLs.
// We resolve them to real article URLs using Playwright.
// ============================================

function isGoogleNewsUrl(url) {
  return url && url.includes('news.google.com/rss/articles/');
}

async function resolveGoogleNewsUrls(urls) {
  const BATCH_SIZE = 5;
  const TOTAL_TIMEOUT_MS = 180000;
  const resolved = new Map();

  if (urls.length === 0) return resolved;

  const b = await initBrowser();
  if (!b) {
    console.log('  Warning: Browser not available for URL resolution');
    return resolved;
  }

  console.log(`\nResolving ${urls.length} Google News URLs...`);
  const startTime = Date.now();

  for (let i = 0; i < urls.length; i += BATCH_SIZE) {
    if (Date.now() - startTime > TOTAL_TIMEOUT_MS) {
      console.log(`  Warning: Hit ${TOTAL_TIMEOUT_MS / 1000}s timeout with ${resolved.size} resolved`);
      break;
    }

    const batch = urls.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(async (gnUrl) => {
      let page;
      try {
        page = await b.newPage();
        await page.goto(gnUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
        await page.waitForTimeout(2000);
        const finalUrl = page.url();
        if (!finalUrl.includes('news.google.com')) {
          return { gnUrl, finalUrl };
        }
        return { gnUrl, finalUrl: null };
      } catch (e) {
        return { gnUrl, finalUrl: null };
      } finally {
        if (page) await page.close().catch(() => {});
      }
    }));

    for (const { gnUrl, finalUrl } of results) {
      if (finalUrl) resolved.set(gnUrl, finalUrl);
    }
  }

  console.log(`  Resolved ${resolved.size}/${urls.length} URLs`);
  return resolved;
}

// ============================================
// SCREENSHOT HANDLER (Playwright)
// ============================================

let browser = null;

async function initBrowser() {
  if (browser) return browser;

  try {
    const { chromium } = require('playwright');
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    return browser;
  } catch (e) {
    console.error('Failed to launch browser:', e.message);
    return null;
  }
}

async function closeBrowser() {
  if (browser) {
    await browser.close();
    browser = null;
  }
}

async function takeScreenshot(source) {
  const b = await initBrowser();
  if (!b) {
    return { ...source, screenshot: null, error: 'Browser not available' };
  }

  try {
    const page = await b.newPage();
    await page.setViewportSize({ width: 1280, height: 900 });

    await page.goto(source.url, {
      waitUntil: 'domcontentloaded',
      timeout: 45000
    });

    // Wait for images/content to load
    await page.waitForTimeout(4000);

    if (!fs.existsSync(SCREENSHOTS_DIR)) {
      fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    }

    const filename = `${source.id}.png`;
    const filepath = path.join(SCREENSHOTS_DIR, filename);

    // Use CDP for consistent screenshot behavior
    const client = await page.context().newCDPSession(page);
    const result = await client.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: 0, y: 0, width: 1280, height: 900, scale: 1 }
    });

    fs.writeFileSync(filepath, Buffer.from(result.data, 'base64'));
    await page.close();

    return { ...source, screenshot: filename, error: null };
  } catch (e) {
    return { ...source, screenshot: null, error: e.message };
  }
}

async function takeTwitterScreenshot(source) {
  const b = await initBrowser();
  if (!b) {
    return { ...source, screenshot: null, tweets: [], error: 'Browser not available' };
  }

  try {
    const page = await b.newPage();
    await page.setViewportSize({ width: 600, height: 900 });

    await page.goto(source.url, {
      waitUntil: 'domcontentloaded',
      timeout: 45000
    });

    // Wait for tweets to render
    await page.waitForTimeout(5000);

    // Try to click translate buttons for Arabic tweets
    let tweets = [];
    try {
      const translateButtons = await page.locator('button:has-text("Translate"), span:has-text("Translate post")').all();
      for (const btn of translateButtons.slice(0, 5)) {
        try {
          await btn.click({ timeout: 2000 });
        } catch (e) { /* continue */ }
      }

      if (translateButtons.length > 0) {
        await page.waitForTimeout(2000);
      }

      // Extract tweet text
      tweets = await page.evaluate(() => {
        const tweetElements = document.querySelectorAll('[data-testid="tweetText"]');
        const results = [];
        tweetElements.forEach((el, i) => {
          if (i < 5) {
            const text = el.innerText?.trim();
            if (text) results.push(text);
          }
        });
        return results;
      });

      // Translate Arabic tweets
      if (tweets.length > 0) {
        tweets = await translateTweets(tweets);
      }
    } catch (e) { /* Tweet extraction failed, continue with screenshot */ }

    if (!fs.existsSync(SCREENSHOTS_DIR)) {
      fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    }

    const filename = `${source.id}.png`;
    const filepath = path.join(SCREENSHOTS_DIR, filename);

    const client = await page.context().newCDPSession(page);
    const result = await client.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: 0, y: 0, width: 600, height: 900, scale: 1 }
    });

    fs.writeFileSync(filepath, Buffer.from(result.data, 'base64'));
    await page.close();

    return { ...source, screenshot: filename, tweets, error: null };
  } catch (e) {
    return { ...source, screenshot: null, tweets: [], error: e.message };
  }
}

// ============================================
// SOURCE SCRAPING
// ============================================

async function scrapeRSSSource(source) {
  try {
    const content = await fetch(source.url);
    const stories = parseRSS(content, source);

    // Auto-translate Arabic RSS headlines to English
    if (source.language === 'ar' && stories.length > 0) {
      console.log(`  Translating ${stories.length} Arabic headlines from ${source.name}...`);
      for (const story of stories) {
        const hasArabic = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(story.headline);
        if (hasArabic) {
          story.originalHeadline = story.headline;
          story.headline = await translateText(story.headline);
          if (story.description && /[\u0600-\u06FF]/.test(story.description)) {
            story.description = await translateText(story.description);
          }
        }
      }
    }

    return { ...source, stories, storyCount: stories.length, error: null };
  } catch (e) {
    return { ...source, stories: [], error: e.message };
  }
}

async function scrapeSource(source) {
  if (source._comment) return null;

  switch (source.type) {
    case 'rss':
      return scrapeRSSSource(source);
    case 'screenshot':
      return takeScreenshot(source);
    case 'twitter':
      return takeTwitterScreenshot(source);
    default:
      return { ...source, stories: [], error: `Unknown type: ${source.type}` };
  }
}

// ============================================
// MAIN SCRAPING LOGIC
// ============================================

async function scrapeAll(config) {
  const sources = config.sources.filter(s => !s._comment);

  const rssSources = sources.filter(s => s.type === 'rss');
  const screenshotSources = sources.filter(s => s.type === 'screenshot' || s.type === 'twitter');

  console.log(`Fetching ${rssSources.length} RSS feeds...`);

  // RSS in parallel
  const rssResults = await Promise.all(rssSources.map(s => scrapeSource(s)));

  for (const r of rssResults) {
    if (r.error) {
      console.log(`  X ${r.name}: ${r.error}`);
    } else {
      console.log(`  OK ${r.name} (${r.storyCount ?? r.stories?.length ?? 0} stories)`);
    }
  }

  // Screenshots sequentially (browser can't handle too many concurrent pages)
  console.log(`\nTaking ${screenshotSources.length} screenshots...`);
  const screenshotResults = [];
  for (const source of screenshotSources) {
    const result = await scrapeSource(source);
    screenshotResults.push(result);
    if (result.error) {
      console.log(`  X ${source.name}: ${result.error}`);
    } else {
      console.log(`  OK ${source.name}`);
    }
  }

  await closeBrowser();

  // Process results
  const allResults = [...rssResults, ...screenshotResults].filter(Boolean);
  const allStories = [];
  const byCategory = {};
  const byPriority = { primary: [], secondary: [], tertiary: [], reference: [] };
  const screenshots = [];
  const failed = [];

  for (const result of allResults) {
    if (result.error) {
      failed.push({ name: result.name, error: result.error });
      continue;
    }

    if (result.stories && result.stories.length > 0) {
      for (const story of result.stories) {
        allStories.push(story);
        const cat = story.category || 'general';
        if (!byCategory[cat]) byCategory[cat] = [];
        byCategory[cat].push(story);
        const pri = story.priority || 'secondary';
        if (byPriority[pri]) byPriority[pri].push(story);
      }
    }

    if (result.screenshot) {
      screenshots.push({
        id: result.id,
        name: result.name,
        url: result.url,
        filename: result.screenshot,
        category: result.category,
        priority: result.priority,
        language: result.language || 'en',
        tweets: result.tweets || []
      });
    }
  }

  // Dedupe stories by URL
  const seen = new Set();
  const deduped = allStories.filter(story => {
    if (seen.has(story.url)) return false;
    seen.add(story.url);
    return true;
  });

  // Resolve Google News redirect URLs
  const googleNewsUrls = [...new Set(
    deduped.filter(s => isGoogleNewsUrl(s.url)).map(s => s.url)
  )];
  const resolvedUrls = await resolveGoogleNewsUrls(googleNewsUrls);
  await closeBrowser();

  for (const story of deduped) {
    if (resolvedUrls.has(story.url)) {
      story.url = resolvedUrls.get(story.url);
    }
  }

  return {
    allStories: deduped,
    byCategory,
    byPriority,
    screenshots,
    failed,
    sourceCount: sources.length,
    successCount: sources.length - failed.length
  };
}

// ============================================
// MAIN
// ============================================

async function main() {
  const config = loadConfig();

  console.log('='.repeat(50));
  console.log(`${config.metadata?.name || 'Gulf Briefing'}`);
  console.log(`Owner: ${config.metadata?.owner || 'Unknown'}`);
  console.log(new Date().toISOString());
  console.log('='.repeat(50));
  console.log('');

  const startTime = Date.now();
  const results = await scrapeAll(config);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  const briefing = {
    metadata: {
      ...config.metadata,
      generated: new Date().toISOString(),
      generatedTimestamp: Date.now()
    },
    stats: {
      sourceCount: results.sourceCount,
      successCount: results.successCount,
      totalStories: results.allStories.length,
      totalScreenshots: results.screenshots.length,
      elapsed: `${elapsed}s`
    },
    stories: {
      all: results.allStories,
      byCategory: results.byCategory,
      byPriority: results.byPriority
    },
    screenshots: results.screenshots,
    feedHealth: { failed: results.failed }
  };

  fs.writeFileSync('briefing.json', JSON.stringify(briefing, null, 2));

  console.log('');
  console.log('='.repeat(50));
  console.log('RESULTS');
  console.log('='.repeat(50));
  console.log(`Sources: ${results.successCount}/${results.sourceCount}`);
  console.log(`Stories: ${results.allStories.length}`);
  console.log(`Screenshots: ${results.screenshots.length}`);

  if (results.failed.length > 0) {
    console.log(`\n${results.failed.length} failed:`);
    for (const f of results.failed) {
      console.log(`  - ${f.name}: ${f.error}`);
    }
  }

  console.log(`\nTime: ${elapsed}s`);

  if (results.allStories.length === 0 && results.screenshots.length === 0) {
    console.error('FAILED: No content scraped');
    process.exit(1);
  }

  console.log('SUCCESS');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
