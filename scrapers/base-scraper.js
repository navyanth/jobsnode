const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

async function launchBrowser() {
  return await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--memory-pressure-off',
      '--disable-component-extensions-with-background-pages',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--max_old_space_size=256',
    ],
  });
}

async function newPage(context) {
  const page = await context.newPage();
  return page;
}

async function safeGoto(page, step, url, timeout = 45000) {
  for (let i = 1; i <= 3; i++) {
    try {
      console.log(`[Browser] ${step} (Attempt ${i})...`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
      return;
    } catch (e) {
      if (e.message.includes('closed')) throw e;
      console.log(`[Browser] ${step} error: ${e.message}`);
      await page.waitForTimeout(3000);
    }
  }
}

function cleanHeaders(rawHeaders) {
  const cleaned = {};
  for (const [k, v] of Object.entries(rawHeaders)) {
    const key = k.toLowerCase();
    if (!key.startsWith(':') &&
        !['accept-encoding', 'host', 'connection', 'content-length'].includes(key)) {
      cleaned[k] = v;
    }
  }
  return cleaned;
}

async function fetchWithRetry(url, headers, options = {}) {
  const { timeout = 30000, retries = 3 } = options;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fetch(url, { headers, signal: AbortSignal.timeout(timeout) });
    } catch (err) {
      if ((err.name === 'TimeoutError' || err.message.includes('timeout')) && attempt < retries) {
        console.log(`[Scraper] Fetch timeout (Attempt ${attempt}/${retries}). Retrying...`);
        continue;
      }
      throw err;
    }
  }
}

function makeWalkinRe() {
  return /\b(walk[- ]?in)\b/i;
}

module.exports = {
  launchBrowser,
  newPage,
  safeGoto,
  cleanHeaders,
  fetchWithRetry,
  makeWalkinRe,
};
