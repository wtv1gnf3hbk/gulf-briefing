#!/usr/bin/env node
/**
 * Injects a style-switcher nav bar into generated HTML files.
 * Run after all three styles are generated.
 *
 * Usage: node add-nav.js
 */

const fs = require('fs');

const NAV_HTML = `
  <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
              font-size: 0.8rem; margin-bottom: 16px; padding: 8px 0;
              border-bottom: 1px solid #e0e0e0; display: flex; gap: 16px;">
    <a href="index.html" style="color: #666; text-decoration: none;">Conversational</a>
    <a href="bullets.html" style="color: #666; text-decoration: none;">Bullets</a>
    <a href="wib.html" style="color: #666; text-decoration: none;">World in Brief</a>
  </div>`;

// Files to inject nav into
const files = ['index.html', 'bullets.html', 'wib.html'];

// Also copy index.html to conversational.html for direct linking
if (fs.existsSync('index.html')) {
  fs.copyFileSync('index.html', 'conversational.html');
}

for (const file of files) {
  if (!fs.existsSync(file)) {
    console.log(`Skipping ${file} (not found)`);
    continue;
  }

  let html = fs.readFileSync(file, 'utf8');

  // Bold the current page's link
  const currentStyle = file.replace('.html', '');
  const label = currentStyle === 'index' ? 'Conversational'
    : currentStyle === 'bullets' ? 'Bullets'
    : 'World in Brief';

  // Replace the matching link with bold version
  let nav = NAV_HTML.replace(
    `>${label}</a>`,
    `; font-weight: 600; color: #1a1a1a">${label}</a>`
  );

  // Inject after the header div
  html = html.replace('</div>\n\n  <script>', nav + '\n</div>\n\n  <script>');

  fs.writeFileSync(file, html);
  console.log(`Added nav to ${file}`);
}

console.log('Done');
