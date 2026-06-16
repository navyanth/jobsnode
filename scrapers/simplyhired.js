const crypto = require('crypto');
const sheets = require('../sheets');
const { notify } = require('../notifier');
const { launchBrowser, safeGoto, makeWalkinRe } = require('./base-scraper');

const NAME = 'simplyhired';
const DEFAULT_SETTINGS = { enabled: '1', keyword: 'java fresher', location: 'india' };
const BASE_URL = 'https://www.simplyhired.co.in';

async function getHeaders() {
  console.log('[SimplyHired] No auth headers needed — using browser-based extraction.');
  return { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };
}

async function scrape(headers) {
  const settings = sheets.getScraperSettings(NAME);
  const keyword = settings.keyword || DEFAULT_SETTINGS.keyword;
  const location = settings.location || DEFAULT_SETTINGS.location;

  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${timestamp}] [SimplyHired] Polling for '${keyword}' in '${location}'...`);

  let browser;
  try {
    browser = await launchBrowser();
    const context = await browser.newContext({
      userAgent: headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      viewport: { width: 1366, height: 768 },
      locale: 'en-IN',
      timezoneId: 'Asia/Kolkata',
    });
    const page = await context.newPage();

    const searchUrl = `${BASE_URL}/search?q=${encodeURIComponent(keyword)}&l=${encodeURIComponent(location)}`;
    await safeGoto(page, 'Loading search results', searchUrl);
    await page.waitForTimeout(5000);

    const jobs = await page.evaluate(() => {
      const results = [];
      const cards = document.querySelectorAll('[data-testid="searchSerpJob"]');

      for (const card of cards) {
        try {
          const titleEl = card.querySelector('[data-testid="searchSerpJobTitle"]');
          const companyEl = card.querySelector('[data-testid="companyName"]');
          const locationEl = card.querySelector('[data-testid="searchSerpJobLocation"]');
          const salaryEl = card.querySelector('[data-testid^="salaryChip"]');
          const dateEl = card.querySelector('[data-testid="searchSerpJobDateStamp"]');
          const linkEl = card.querySelector('a[href*="/job/"]');
          const snippetEl = card.querySelector('[data-testid="searchSerpJobSnippet"]');

          const title = titleEl ? titleEl.textContent.trim() : '';
          const company = companyEl ? companyEl.textContent.trim() : '';
          const loc = locationEl ? locationEl.textContent.trim() : '';
          const salary = salaryEl ? salaryEl.textContent.trim() : '';
          const url = linkEl ? (linkEl.href.startsWith('http') ? linkEl.href : 'https://www.simplyhired.co.in' + linkEl.getAttribute('href')) : '';
          const dateText = dateEl ? dateEl.textContent.trim() : '';
          const snippet = snippetEl ? snippetEl.textContent.trim() : '';

          if (title && company) {
            results.push({ title, company, location: loc, salary, url, dateText, snippet });
          }
        } catch (e) { /* skip malformed card */ }
      }
      return results;
    });

    await browser.close();
    browser = null;

    console.log(`[SimplyHired] Found ${jobs.length} jobs.`);

    const walkinRe = makeWalkinRe();
    for (const job of jobs) {
      const title = job.title || 'Unknown';
      const company = job.company || 'Unknown';
      const loc = job.location || location;
      const url = job.url || '';

      const hash = makeHash(title, company, url);

      if (sheets.isNewJob(hash)) {
        console.log(`[SimplyHired] Found job: ${title} @ ${company}`);

        const jobData = {
          title,
          company,
          location: loc,
          url,
          source: NAME,
          hash,
          date: new Date().toISOString(),
          isWalkin: walkinRe.test(title + ' ' + company + ' ' + loc + ' ' + (job.salary || '')),
          salary: job.salary || undefined,
        };

        console.log(`      -> NEW: ${title} @ ${company}`);
        await notify(jobData);
        await sheets.saveJob(jobData);
      }
    }

    return true;
  } catch (err) {
    console.log(`[SimplyHired] Scrape error: ${err.message}`);
    if (browser) await browser.close().catch(() => { });
    return false;
  }
}

function makeHash(title, company, url) {
  const raw = `${title.toLowerCase().trim()}|${company.toLowerCase().trim()}|${url.trim()}`;
  return crypto.createHash('md5').update(raw).digest('hex');
}

function getDefaultSettings() {
  return { ...DEFAULT_SETTINGS };
}

function getSettingsSchema() {
  return [
    { key: 'enabled', label: 'Enabled', type: 'select', options: [
      { value: '1', label: 'Yes' },
      { value: '0', label: 'No' },
    ]},
    { key: 'keyword', label: 'Keyword', type: 'text', placeholder: 'e.g. java fresher' },
    { key: 'location', label: 'Location', type: 'text', placeholder: 'e.g. india' },
  ];
}

module.exports = {
  name: NAME,
  getHeaders,
  scrape,
  getDefaultSettings,
  getSettingsSchema,
};
