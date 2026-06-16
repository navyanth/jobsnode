const crypto = require('crypto');
const sheets = require('../sheets');
const { notify } = require('../notifier');
const { launchBrowser, safeGoto, fetchWithRetry, makeWalkinRe } = require('./base-scraper');

const NAME = 'simplyhired';
const DEFAULT_SETTINGS = { enabled: '1', keyword: 'software developer fresher', location: 'Hyderabad, Telangana' };
const BASE_URL = 'https://www.simplyhired.co.in';

async function extractBuildId() {
  let browser;
  try {
    browser = await launchBrowser();
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      viewport: { width: 1366, height: 768 },
      locale: 'en-IN',
      timezoneId: 'Asia/Kolkata',
    });
    const page = await context.newPage();
    await safeGoto(page, 'Loading homepage', `${BASE_URL}/`);
    await page.waitForTimeout(3000);

    const buildId = await page.evaluate(() => {
      const script = document.getElementById('__NEXT_DATA__');
      if (script) {
        try { return JSON.parse(script.textContent).buildId; } catch (e) { return null; }
      }
      return null;
    });

    await browser.close();
    browser = null;

    if (buildId) {
      console.log(`[SimplyHired] Build ID: ${buildId}`);
      return buildId;
    }
    console.log('[SimplyHired] Build ID not found, using fallback.');
    return 'fax-YdvvdVlHuYP_SPx0y';
  } catch (err) {
    console.log(`[SimplyHired] Build ID extraction error: ${err.message}`);
    if (browser) await browser.close().catch(() => { });
    return 'fax-YdvvdVlHuYP_SPx0y';
  }
}

async function getHeaders() {
  console.log('[SimplyHired] Capturing build ID from homepage...');
  const buildId = await extractBuildId();
  return { buildId, 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'x-nextjs-data': '1' };
}

async function scrape(headers) {
  const settings = sheets.getScraperSettings(NAME);
  const keyword = settings.keyword || DEFAULT_SETTINGS.keyword;
  const location = settings.location || DEFAULT_SETTINGS.location;
  const buildId = headers.buildId || 'fax-YdvvdVlHuYP_SPx0y';

  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${timestamp}] [SimplyHired] Polling for '${keyword}' in '${location}'...`);

  const apiUrl = `${BASE_URL}/_next/data/${buildId}/en-IN/search.json?q=${encodeURIComponent(keyword)}&l=${encodeURIComponent(location)}`;

  const requestHeaders = {
    'user-agent': headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'x-nextjs-data': '1',
    'referer': `${BASE_URL}/`,
    'accept': 'application/json',
  };

  let res;
  try {
    res = await fetchWithRetry(apiUrl, requestHeaders, { timeout: 30000, retries: 3 });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.message.includes('timeout')) {
      console.log('[SimplyHired] All fetch attempts timed out.');
      return false;
    }
    throw err;
  }

  if (res.status === 200) {
    const data = await res.json();
    const jobs = data.pageProps?.jobs || [];
    console.log(`[SimplyHired] Got ${jobs.length} jobs from API.`);

    const walkinRe = makeWalkinRe();
    for (const job of jobs) {
      const title = job.title || 'Unknown';
      const company = job.company || 'Unknown';
      const loc = job.location || location;
      const url = job.botUrl ? `${BASE_URL}${job.botUrl}` : '';
      const salaryInfo = job.salaryInfo || '';

      const hash = makeHash(title, company, url);

      if (sheets.isNewJob(hash)) {
        console.log(`[SimplyHired] Found job: ${title} @ ${company}`);

        const jobDate = job.dateOnIndeed ? new Date(job.dateOnIndeed).toISOString() : new Date().toISOString();

        const jobData = {
          title,
          company,
          location: loc,
          url,
          source: NAME,
          hash,
          date: jobDate,
          isWalkin: walkinRe.test(title + ' ' + company + ' ' + loc + ' ' + salaryInfo),
          salary: salaryInfo || undefined,
          snippet: job.snippet || undefined,
        };

        console.log(`      -> NEW: ${title} @ ${company}`);
        await notify(jobData);
        await sheets.saveJob(jobData);
      }
    }
    return true;
  } else {
    console.log(`[SimplyHired] Got ${res.status} — may need fresh build ID.`);
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
    { key: 'keyword', label: 'Keyword', type: 'text', placeholder: 'e.g. software developer fresher' },
    { key: 'location', label: 'Location', type: 'text', placeholder: 'e.g. Hyderabad, Telangana' },
  ];
}

module.exports = {
  name: NAME,
  getHeaders,
  scrape,
  getDefaultSettings,
  getSettingsSchema,
};
