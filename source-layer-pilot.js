#!/usr/bin/env node
// Pilot wiring: gulf-briefing uses source-layer for its non-Playwright sources.
// This is a standalone demo — does NOT replace generate-briefing.js yet.
// Run: node source-layer-pilot.js
//
// Once Adam confirms output, the same call pattern can be folded into
// generate-briefing.js alongside (or replacing) sources.json + scrape-feed.js.

const sources = require('/Users/adam.pasick/Downloads/source-layer');

(async () => {
  const items = await sources.fetch({
    sources: ['rss', 'gdelt', 'palewire', 'primary-sources'],
    region: 'gulf',
    since: '24h',
  });

  const bySource = items.reduce((a, i) => {
    a[i.source] = (a[i.source] || 0) + 1;
    return a;
  }, {});

  console.log(`Gulf briefing source-layer pull — ${items.length} items`);
  console.log('By source:', bySource);
  console.log('\nTop 10 headlines:');
  for (const it of items.slice(0, 10)) {
    console.log(`  [${it.source}] ${(it.title || '').slice(0, 100)}`);
  }
})();
