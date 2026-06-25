// Tests for the X-scrape freshness gate (computeNewestAgeMs).
//
// The gate exists because a scrape can hit 100% handle coverage yet serve a
// frozen/cached timeline where every "latest" tweet is days old — the exact
// failure that made the Gulf Wire look fixed while serving 15-day-old tweets.
// computeNewestAgeMs is the pure core the run uses to decide fail-red.

const { test } = require('node:test');
const assert = require('node:assert');
const { computeNewestAgeMs } = require('../lib/scrape-twitter.js');

const NOW = Date.parse('2026-06-25T13:00:00.000Z');
const iso = (ms) => new Date(NOW - ms).toISOString();
const HOUR = 3600000;

test('returns small age for a fresh tweet', () => {
  const items = [{ date: iso(30 * 60 * 1000) }]; // 30 min old
  const age = computeNewestAgeMs(items, NOW);
  assert.ok(age >= 29 * 60 * 1000 && age <= 31 * 60 * 1000, `got ${age}`);
});

test('uses the NEWEST item, not the oldest', () => {
  const items = [
    { date: iso(15 * 24 * HOUR) }, // 15 days old (the stale June-10 case)
    { date: iso(1 * HOUR) },       // 1 hour old
    { date: iso(8 * 24 * HOUR) },
  ];
  const age = computeNewestAgeMs(items, NOW);
  assert.ok(age <= 1.1 * HOUR, `expected ~1h, got ${age / HOUR}h`);
});

test('flags a uniformly stale (15-day) set as older than the 48h threshold', () => {
  const items = Array.from({ length: 44 }, () => ({ date: iso(15 * 24 * HOUR) }));
  const age = computeNewestAgeMs(items, NOW);
  assert.ok(age > 48 * HOUR, 'a 15-day-old set must exceed the 48h gate');
});

test('a fresh set stays under the 48h threshold', () => {
  const items = Array.from({ length: 44 }, (_, i) => ({ date: iso((i % 6) * HOUR) }));
  const age = computeNewestAgeMs(items, NOW);
  assert.ok(age < 48 * HOUR, 'recent tweets must pass the gate');
});

test('no items / unparseable dates => Infinity (treated as stale, never silent-green)', () => {
  assert.strictEqual(computeNewestAgeMs([], NOW), Infinity);
  assert.strictEqual(computeNewestAgeMs([{ date: 'not-a-date' }], NOW), Infinity);
  assert.strictEqual(computeNewestAgeMs([{ foo: 1 }], NOW), Infinity);
});

test('ignores unparseable dates when a valid one is present', () => {
  const items = [{ date: 'garbage' }, { date: iso(2 * HOUR) }];
  const age = computeNewestAgeMs(items, NOW);
  assert.ok(age >= 1.9 * HOUR && age <= 2.1 * HOUR, `got ${age / HOUR}h`);
});
