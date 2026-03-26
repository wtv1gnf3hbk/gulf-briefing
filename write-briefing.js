#!/usr/bin/env node
/**
 * Gulf Briefing — Claude API writer
 *
 * Reads briefing.json (scraped data) and calls Claude to produce:
 *   - briefing.md (markdown)
 *   - index.html (styled page with screenshots, refresh button, feedback)
 *
 * Supports 3 output styles via --style flag:
 *   conversational (default), bullets, wib
 *
 * Requires: ANTHROPIC_API_KEY environment variable
 */

const https = require('https');
const fs = require('fs');

// Parse --style flag from command line
const styleArg = process.argv.find(a => a.startsWith('--style='));
const STYLE = styleArg ? styleArg.split('=')[1] : 'conversational';
if (!['conversational', 'bullets', 'wib'].includes(STYLE)) {
  console.error('Unknown style: ' + STYLE + '. Use: conversational, bullets, wib');
  process.exit(1);
}

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!ANTHROPIC_API_KEY) {
  console.error('Missing ANTHROPIC_API_KEY environment variable');
  process.exit(1);
}

// ============================================
// CLAUDE API CALL
// ============================================

function callClaude(prompt, systemPrompt = '') {
  return new Promise((resolve, reject) => {
    const messages = [{ role: 'user', content: prompt }];

    const body = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2500,
      system: systemPrompt,
      messages
    });

    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) {
            reject(new Error(json.error.message));
          } else {
            resolve(json.content[0].text);
          }
        } catch (e) {
          reject(new Error('Failed to parse API response: ' + data.slice(0, 200)));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(120000, () => {
      req.destroy();
      reject(new Error('API timeout'));
    });

    req.write(body);
    req.end();
  });
}

// ============================================
// TIMEZONE UTILITIES
// ============================================

function formatTimestamp(timezone = 'Asia/Dubai') {
  const now = new Date();

  // Format date
  const dateStr = now.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: timezone
  });

  // Format time
  const timeStr = now.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: timezone
  });

  // Get timezone abbreviation
  const tzAbbr = now.toLocaleTimeString('en-US', {
    timeZone: timezone,
    timeZoneName: 'short'
  }).split(' ').pop();

  // ISO date for machine-readable contexts (feedback, etc.)
  const isoDate = now.toLocaleDateString('en-CA', { timeZone: timezone }); // YYYY-MM-DD

  return { dateStr, timeStr, tzAbbr, isoDate, full: `${dateStr} at ${timeStr} ${tzAbbr}` };
}

// ============================================
// HTML GENERATION
// ============================================

function generateHTML(briefingText, config) {
  const timezone = config.metadata?.timezone || 'Asia/Dubai';
  const timestamp = formatTimestamp(timezone);
  const title = config.metadata?.name || 'Gulf Briefing';
  const screenshots = config.screenshots || [];

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: Georgia, 'Times New Roman', serif;
      line-height: 1.7;
      max-width: 680px;
      margin: 0 auto;
      padding: 32px 16px;
      background: #fafafa;
      color: #1a1a1a;
    }
    .header {
      margin-bottom: 24px;
      padding-bottom: 16px;
      border-bottom: 1px solid #e0e0e0;
    }
    .title {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 1.5rem;
      font-weight: 700;
      margin-bottom: 8px;
    }
    .timestamp {
      font-size: 0.85rem;
      color: #666;
    }
    .refresh-link {
      color: #666;
      text-decoration: underline;
      cursor: pointer;
    }
    h1, h2, strong {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }
    p { margin-bottom: 16px; }
    ul { margin: 12px 0 20px 0; padding-left: 0; list-style: none; }
    li { margin-bottom: 10px; padding-left: 16px; position: relative; }
    li::before { content: "•"; position: absolute; left: 0; color: #999; }
    a {
      color: #1a1a1a;
      text-decoration: underline;
      text-decoration-color: #999;
      text-underline-offset: 2px;
    }
    a:hover { text-decoration-color: #333; }
    strong { font-weight: 600; }
    .section-header { margin-top: 24px; margin-bottom: 12px; }
    .screenshots-section {
      margin-top: 40px;
      padding-top: 24px;
      border-top: 1px solid #e0e0e0;
    }
    .screenshots-header {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 1.1rem;
      font-weight: 600;
      margin-bottom: 16px;
    }
    .screenshots-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 16px;
    }
    .screenshot-card {
      border: 1px solid #e0e0e0;
      border-radius: 8px;
      overflow: hidden;
      background: white;
    }
    .screenshot-card img {
      width: 100%;
      height: auto;
      display: block;
    }
    .screenshot-card .label {
      padding: 8px 12px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 0.85rem;
      background: #f5f5f5;
      border-top: 1px solid #e0e0e0;
    }
    .screenshot-card .label a {
      color: #666;
      text-decoration: none;
    }
    .screenshot-card .label a:hover {
      text-decoration: underline;
    }
    /* Feedback section */
    .feedback-section {
      margin-top: 40px;
      padding-top: 24px;
      border-top: 1px solid #e0e0e0;
      text-align: center;
    }
    .feedback-prompt {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 0.85rem;
      color: #666;
      margin-bottom: 12px;
    }
    .feedback-buttons {
      display: flex;
      justify-content: center;
      gap: 12px;
      margin-bottom: 12px;
    }
    .feedback-btn {
      font-size: 1.4rem;
      padding: 8px 16px;
      border: 1px solid #ddd;
      border-radius: 8px;
      background: transparent;
      cursor: pointer;
      transition: background 0.15s;
    }
    .feedback-btn:hover { background: #f0f0f0; }
    .feedback-btn.selected { background: #e8e8e8; border-color: #999; }
    .feedback-textarea {
      display: block;
      width: 100%;
      max-width: 480px;
      margin: 12px auto;
      padding: 10px;
      border: 1px solid #ddd;
      border-radius: 6px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 0.9rem;
      resize: vertical;
    }
    .feedback-submit {
      display: block;
      margin: 8px auto;
      padding: 6px 20px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 0.85rem;
      border: 1px solid #ccc;
      border-radius: 4px;
      background: #f5f5f5;
      cursor: pointer;
    }
    .feedback-submit:hover { background: #e8e8e8; }
    .feedback-thanks {
      display: none;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 0.85rem;
      color: #666;
      margin-top: 8px;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="title">${title}</div>
    <div class="timestamp">
      Generated ${timestamp.full}
      · <a class="refresh-link" onclick="refreshBriefing()">Refresh</a>
    </div>
  </div>

  <script>
    const WORKER_URL = 'https://gulf-briefing-refresh.adampasick.workers.dev';

    async function refreshBriefing() {
      const link = event.target;
      const originalText = link.textContent;

      try {
        // Step 1: Trigger the workflow
        link.textContent = 'Triggering...';
        const triggerRes = await fetch(\`\${WORKER_URL}/trigger\`, { method: 'POST' });
        if (!triggerRes.ok) throw new Error('Failed to trigger');

        // Step 2: Wait for run to be created
        link.textContent = 'Starting...';
        await new Promise(r => setTimeout(r, 3000));

        // Step 3: Get the run ID
        link.textContent = 'Finding run...';
        const runsRes = await fetch(\`\${WORKER_URL}/runs\`);
        const runsData = await runsRes.json();
        if (!runsData.workflow_runs?.length) throw new Error('No runs found');

        const runId = runsData.workflow_runs[0].id;
        const runUrl = runsData.workflow_runs[0].html_url;

        // Step 4: Poll for completion
        let attempts = 0;
        while (attempts < 60) {
          const statusRes = await fetch(\`\${WORKER_URL}/status/\${runId}\`);
          const statusData = await statusRes.json();

          if (statusData.status === 'completed') {
            if (statusData.conclusion === 'success') {
              link.textContent = 'Done! Reloading...';
              await new Promise(r => setTimeout(r, 5000));
              location.reload(true);
              return;
            } else {
              link.innerHTML = \`Failed (<a href="\${runUrl}" target="_blank">logs</a>)\`;
              return;
            }
          }

          link.textContent = \`Running... \${attempts * 5}s\`;
          await new Promise(r => setTimeout(r, 5000));
          attempts++;
        }

        link.innerHTML = \`Timeout (<a href="\${runUrl}" target="_blank">check</a>)\`;
      } catch (error) {
        console.error('Refresh error:', error);
        link.textContent = 'Error';
        setTimeout(() => { link.textContent = originalText; }, 3000);
      }
    }
  </script>

  <div id="content">
${briefingText
  .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>')
  .replace(/^- (.+)$/gm, '<li>$1</li>')
  .replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
  .split('\n')
  .map(line => {
    if (line.startsWith('<ul>') || line.startsWith('<li>') || line.startsWith('</ul>')) return line;
    if (line.startsWith('<strong>')) return `<p class="section-header">${line}</p>`;
    if (line.trim() && !line.startsWith('<')) return `<p>${line}</p>`;
    return line;
  })
  .join('\n')}
  </div>

  ${screenshots.length > 0 ? `
  <div class="screenshots-section">
    <div class="screenshots-header">📸 Homepage Screenshots</div>
    <div class="screenshots-grid">
      ${screenshots.map(s => `
      <div class="screenshot-card">
        <a href="${s.url}" target="_blank">
          <img src="screenshots/${s.filename}" alt="${s.name}" loading="lazy">
        </a>
        <div class="label">
          <a href="${s.url}" target="_blank">${s.name}</a>
          ${s.language && s.language !== 'en' ? `<span style="color:#999">(${s.language})</span>` : ''}
        </div>
      </div>
      `).join('')}
    </div>
  </div>
  ` : ''}

  <div class="feedback-section" id="feedback-section" data-date="${timestamp.isoDate}">
    <div class="feedback-prompt">How was today's briefing?</div>
    <div class="feedback-buttons" id="feedback-buttons">
      <button class="feedback-btn" data-reaction="thumbsup" onclick="selectReaction(this)">&#x1F44D;</button>
      <button class="feedback-btn" data-reaction="thumbsdown" onclick="selectReaction(this)">&#x1F44E;</button>
    </div>
    <textarea class="feedback-textarea" id="feedback-comment" placeholder="Optional: tell us more..." rows="3"></textarea>
    <button class="feedback-submit" id="feedback-submit" onclick="submitFeedback()">Send</button>
    <div class="feedback-thanks" id="feedback-thanks">Thanks for the feedback!</div>
  </div>

  <script>
    // --- Feedback ---
    var FEEDBACK_URL = 'https://gulf-briefing-refresh.adampasick.workers.dev/feedback';
    var selectedReaction = null;

    // Check if already submitted for this briefing date
    (function() {
      var dateKey = document.getElementById('feedback-section').dataset.date;
      if (localStorage.getItem('feedback-sent-' + dateKey)) {
        document.getElementById('feedback-buttons').style.display = 'none';
        document.getElementById('feedback-prompt').style.display = 'none';
        document.getElementById('feedback-thanks').style.display = 'block';
        document.getElementById('feedback-thanks').textContent = 'Feedback sent \u2014 thank you!';
      }
    })();

    function selectReaction(btn) {
      document.querySelectorAll('.feedback-btn').forEach(function(b) { b.classList.remove('selected'); });
      btn.classList.add('selected');
      selectedReaction = btn.dataset.reaction;
    }

    async function submitFeedback() {
      // Need either a reaction or a comment (or both)
      var comment = document.getElementById('feedback-comment').value.trim();
      if (!selectedReaction && !comment) return;
      var dateKey = document.getElementById('feedback-section').dataset.date;
      var submitBtn = document.getElementById('feedback-submit');
      submitBtn.textContent = 'Sending...';
      submitBtn.disabled = true;

      try {
        var res = await fetch(FEEDBACK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            reaction: selectedReaction || 'comment',
            comment: comment || '',
            briefingDate: dateKey
          })
        });
        if (!res.ok) throw new Error('Server error');

        // Success — hide form, show thanks, remember in localStorage
        document.getElementById('feedback-buttons').style.display = 'none';
        document.getElementById('feedback-comment').style.display = 'none';
        document.getElementById('feedback-submit').style.display = 'none';
        document.querySelector('.feedback-prompt').style.display = 'none';
        document.getElementById('feedback-thanks').style.display = 'block';
        localStorage.setItem('feedback-sent-' + dateKey, '1');
      } catch (e) {
        submitBtn.textContent = 'Error \u2014 try again';
        submitBtn.disabled = false;
      }
    }
  </script>
</body>
</html>`;
}

// ============================================
// PROMPT BUILDING
// ============================================

function buildPrompt(briefing) {
  const config = briefing.metadata || {};
  const ownerName = config.owner || 'the Gulf correspondent';
  const timezone = config.timezone || 'Asia/Dubai';

  // Get current time in the target timezone for greeting
  const hour = new Date().toLocaleString('en-US', {
    hour: 'numeric',
    hour12: false,
    timeZone: timezone
  });
  const hourNum = parseInt(hour);

  let greeting;
  if (hourNum >= 5 && hourNum < 12) {
    greeting = 'Good morning from the Gulf.';
  } else if (hourNum >= 12 && hourNum < 17) {
    greeting = 'Good afternoon from the Gulf.';
  } else if (hourNum >= 17 && hourNum < 21) {
    greeting = 'Good evening from the Gulf.';
  } else {
    greeting = "Here's your Gulf briefing.";
  }

  // Organize stories for the prompt.
  // Group by source so Claude sees equal representation from all outlets,
  // rather than the old priority-tier bucketing which caused NHK/Japan Times
  // to dominate while Kyodo, Yomiuri, AP, Bloomberg etc. were buried or skipped.
  const allStories = (briefing.stories?.all || []);

  // Build a per-source map: { sourceName: [story, story, ...] }
  const bySource = {};
  for (const story of allStories) {
    if (!bySource[story.source]) bySource[story.source] = [];
    if (bySource[story.source].length < 5) {  // max 5 per source for token budget
      bySource[story.source].push({
        headline: story.headline,
        url: story.url,
        description: story.description || ''
      });
    }
  }

  // Format as a readable block: source name as header, then its stories
  const storiesBlock = Object.entries(bySource)
    .map(([source, stories]) => {
      const items = stories.map(s => `  - ${s.headline} (${s.url})`).join('\n');
      return `**${source}**\n${items}`;
    })
    .join('\n\n');

  // Get screenshots info
  const screenshots = briefing.screenshots || [];

  // Load shared style rules from file (synced from nyt-concierge/style-rules-prompt.txt).
  // These are the universal rules enforced by validate-draft.js and fix-draft.js.
  const styleRulesPath = require('path').join(__dirname, 'style-rules-prompt.txt');
  const styleRules = fs.readFileSync(styleRulesPath, 'utf8').trim();

  const systemPrompt = `You are writing a daily Gulf news briefing for ${ownerName}, covering the 6 GCC states (Saudi Arabia, UAE, Qatar, Bahrain, Kuwait, Oman) and Yemen for the New York Times.

Your job is to synthesize scraped headlines, official Twitter/X feeds, and news agency content into a readable, actionable briefing.

${styleRules}

BRIEFING-SPECIFIC RULES:
1. Write in full sentences, not headline fragments.
2. Be conversational, like briefing a well-informed colleague.
3. Focus on the Gulf/Arabian Peninsula region. International stories only if they directly affect the region.
4. ALWAYS identify which Yemen entity (IRG, Houthi/Ansar Allah, STC) is involved in any Yemen story.
5. For Saudi Arabia, distinguish between government positions and MBS personal moves.
6. For UAE, note whether something is Abu Dhabi-driven or Dubai-driven when relevant.
7. Official Twitter/X posts from ministers and royals are PRIMARY SOURCES.
8. Energy/OPEC stories are always relevant.`;

  const userPrompt = `${greeting} Here is the scraped data.

Write a briefing using this headline data. Use these sections in order:

1. **Top News** (2-3 paragraphs, no header): Synthesize the top Gulf stories in flowing prose. Lead with the single most consequential development.

LEAD STORY PRIORITY:
  1. Military/security (Houthi attacks, coalition operations, Iran tensions)
  2. Major diplomatic developments (GCC summits, normalization moves, sanctions)
  3. Energy/economic shocks (OPEC decisions, oil prices, sovereign wealth moves)
  4. Yemen conflict developments (peace talks, territory changes, humanitarian)
  5. Political transitions, succession, governance changes
  6. Mega-projects, economic diversification (NEOM, Vision 2030, tourism)
When in doubt: "Would a bureau chief rearrange their day for this?" If no, it's not the lead.

2. **Energy & Economy** (3-4 bullets): Oil, OPEC, sovereign wealth funds, business, trade.

3. **Country Watch** (organized by country, only countries with news):
  - **Saudi Arabia**
  - **UAE**
  - **Qatar**
  - **Bahrain / Kuwait / Oman** (combined if light)
  - **Yemen** (always separate, note which faction)

4. **Official Signals** (2-3 items): Notable statements from officials, Twitter/X posts from key figures that signal policy direction.

5. **Coverage Flags** (1-2 sentences): Stories where international outlets are ahead of local press, or gaps worth NYT Gulf correspondent attention.

6. **Sources** (bulleted list with links): Every source cited.

Every bullet must have at least one link. Vary attribution: "Reuters reports", "according to WAM", "Al Arabiya reports", "per the Saudi Press Agency", "Al Jazeera reports", "Bloomberg reports."

FLAG any stories where:
- International outlets are ahead of local/regional press
- A story might warrant dedicated NYT Gulf coverage
- There is a gap between Arabic-language and English-language coverage

Here is the data, organized by outlet:

${storiesBlock}

HOMEPAGE SCREENSHOTS CAPTURED (Gulf outlets, competitors, Twitter):
${screenshots.map(s => `- ${s.name} (${s.language || 'en'}): screenshots/${s.filename}`).join('\n')}

TWITTER/X FEED CONTENT (translated where available):
${screenshots
  .filter(s => s.category?.includes('twitter') && s.tweets && s.tweets.length > 0)
  .map(s => `**${s.name}** (@${s.url.split('/').pop()}):\n${s.tweets.map((t, i) => `  ${i + 1}. ${t}`).join('\n')}`)
  .join('\n\n') || 'No tweet content extracted'}

IMPORTANT: If a tweet from a minister, royal, or official account relates to a top story, cite it directly. These are primary sources, not social media commentary.

Write the briefing now. Keep it concise but comprehensive.`;

  return { systemPrompt, userPrompt };
}

// ============================================
// MAIN
// ============================================

async function main() {
  console.log('Reading briefing.json...');

  if (!fs.existsSync('briefing.json')) {
    console.error('briefing.json not found. Run generate-briefing.js first.');
    process.exit(1);
  }

  const briefing = JSON.parse(fs.readFileSync('briefing.json', 'utf8'));

  console.log(`Found ${briefing.stats?.totalStories || 0} stories`);
  console.log('');

  // Build prompt
  const { systemPrompt, userPrompt } = buildPrompt(briefing);

  console.log('Calling Claude API...');
  const startTime = Date.now();

  try {
    const briefingText = await callClaude(userPrompt, systemPrompt);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`Claude responded in ${elapsed}s`);

    // Save markdown
    fs.writeFileSync('briefing.md', briefingText);
    console.log('Saved briefing.md');

    // Save HTML
    const htmlContent = generateHTML(briefingText, briefing);
    fs.writeFileSync('index.html', htmlContent);
    console.log('Saved index.html');

    console.log('');
    console.log('✅ Briefing written successfully');

  } catch (e) {
    console.error('❌ Failed to write briefing:', e.message);
    process.exit(1);
  }
}

main();
