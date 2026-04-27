# lib/scrape-twitter.js — shared briefing-toolkit

Shared X.com scraping module for the briefing repos (gulf-briefing,
afpak-briefing, japan-briefing, dach-digest, iran-briefing, etc).

This module **lives in gulf-briefing/lib/** but is structured to be copy-and-go for any briefing that needs Twitter scraping. Bug fixes ship from here; consumers re-pull when they want the latest.

## What it does

- Scrapes the latest 5 tweets from each X.com profile in your `sources.json`
- Skips pinned tweets (they're old; pollute "latest activity")
- Falls back to `syndication.twitter.com` when X serves a login wall
- Translates non-Latin-script tweets via Google's free Translate gateway
- Captures **permalinks + timestamps** (required for URL-dedup in feed.json)
- Merges into `feed.json` with the same shape as `scrape-feed.js` items
- Logs sanity warnings (coverage drop, per-source drops) so silent regressions become visible

## Adopt it in another briefing

**Step 1.** Copy `lib/scrape-twitter.js` to `<your-briefing>/lib/scrape-twitter.js`.

(Or curl at workflow runtime — see "CI auto-update" below.)

**Step 2.** Make sure your `sources.json` has Twitter sources with this shape:

```json
{
  "id": "twitter_minister_x",
  "name": "Minister X",
  "type": "twitter",
  "url": "https://x.com/minister_x",
  "category": "iran_twitter",
  "priority": "primary"
}
```

**Step 3.** In your `generate-briefing.js`, wire up `--twitter-only` mode:

```js
const { runTwitterOnly } = require('./lib/scrape-twitter');

const COUNTRY_MAP = {
  // category → country label, used by the Wire UI's filter chips
  iran: 'Iran',
  iran_twitter: 'Iran',
  // …
};

const TWITTER_ONLY = process.argv.slice(2).includes('--twitter-only');

async function main() {
  const config = JSON.parse(fs.readFileSync('./sources.json', 'utf8'));
  if (TWITTER_ONLY) {
    const sources = config.sources.filter(s => !s._comment && s.type === 'twitter');
    await runTwitterOnly({
      sources,
      countryMap: COUNTRY_MAP,
      feedPath: './feed.json',
      maxItems: 300,        // cap for feed.json
    });
    return;
  }
  // …rest of your full briefing flow
}
```

**Step 4.** Add a workflow at `.github/workflows/twitter.yml`:

```yaml
name: Scrape Twitter
on:
  schedule:
    - cron: '15 */3 * * *'   # every 3h
  workflow_dispatch:
permissions:
  contents: write
concurrency:
  group: write-main          # share with feed.yml so pushes don't race
  cancel-in-progress: false
jobs:
  scrape:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm install
      - run: npx playwright install chromium
      - run: node generate-briefing.js --twitter-only
      - name: Commit feed.json
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git fetch origin main
          git reset --soft origin/main
          git add feed.json
          git diff --cached --quiet && exit 0
          git commit -m "Update tweets $(date -u '+%Y-%m-%d %H:%M UTC')"
          git push origin main
```

## API reference

| Export | Use |
|---|---|
| `runTwitterOnly(opts)` | Top-level entry point. Scrapes, merges, logs. Recommended. |
| `scrapeOneHandle(source, opts)` | Per-source scrape (x.com → fallback → translate) |
| `extractTweetsFromXPage(page, max)` | Just the x.com DOM extraction |
| `extractTweetsFromSyndication(page, handle, max)` | Just the syndication fallback |
| `tweetsToFeedItems(results, countryMap)` | Shape into feed.json items |
| `mergeTweetsIntoFeed(items, opts)` | URL-dedup merge into feed.json |
| `translateText`, `translateTweets` | Google Translate gateway |
| `detectLoginWall(bodyText)` | Heuristic check |

`runTwitterOnly` accepts:

| Option | Default | Notes |
|---|---|---|
| `sources` | required | Array of twitter-type sources from your `sources.json` |
| `countryMap` | `{}` | category → country label (per-briefing) |
| `feedPath` | `'./feed.json'` | Where to read/write |
| `maxItems` | `300` | Cap on feed.json items |
| `shouldTranslate` | non-Latin regex | Predicate; pass your own to override |
| `maxTweetsPerHandle` | `5` | How many tweets to capture per source |

## Hard-won lessons baked in

1. **Never click X's "Translate post" button.** It re-renders the article and breaks the `<time> → <a href="/status/...">` permalink relationship. Translation runs after, via Google Translate API. (Cost us 6 silent days of dropped tweets on gulf-briefing — 2026-04-27.)
2. **Skip pinned tweets** via `[data-testid="socialContext"]` containing "Pinned." They pollute latest activity with old content.
3. **Always have a syndication fallback.** GitHub Actions IPs sometimes get bot-flagged on x.com → login wall. `syndication.twitter.com` (used by embed widgets) is more permissive.
4. **Drop tweets without permalinks; don't paper over.** Pushing items with profile-URL fallbacks pollutes URL-dedup in feed.json. The "extracted N, merged 0" warning surfaces this.
5. **Sanity-warn on coverage drop.** If <50% of attempted handles produce items, log a WARNING. Catches X DOM changes early.

## CI auto-update (optional, future)

To get bug fixes automatically without manual file copies, replace step 4's `node generate-briefing.js` with a curl-pull pattern:

```yaml
- name: Pull latest scrape-twitter
  run: curl -fsSL https://raw.githubusercontent.com/wtv1gnf3hbk/gulf-briefing/main/lib/scrape-twitter.js > lib/scrape-twitter.js
- run: node generate-briefing.js --twitter-only
```

This pins to gulf-briefing's `main` branch. For more controlled rollouts, pin to a specific commit SHA in the URL.

## Known fragility

- X DOM selectors (`data-testid="tweet"`, `data-testid="tweetText"`, `time[datetime]`) — change every few months. Universal failure when they do; easy to spot.
- GitHub Actions IPs sometimes rate-limited / login-walled — that's what the syndication fallback is for. Lower-fidelity but better than zero.
- Google Translate free gateway can rate-limit — Arabic tweets degrade to raw text on failure (not a crash).

## Provenance

Combined from gulf-briefing (permalink/timestamp capture, sanity warnings, no translate-click) and afpak-briefing (pinned-skip, login-wall detection, syndication fallback). Written 2026-04-27 after the gulf permalink-drop outage.
