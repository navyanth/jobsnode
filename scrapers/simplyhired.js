const crypto = require('crypto');
const sheets = require('../sheets');
const { notify } = require('../notifier');
const { launchBrowser, safeGoto, fetchWithRetry, makeWalkinRe } = require('./base-scraper');

const NAME = 'simplyhired';
const DEFAULT_SETTINGS = { enabled: '1', keyword: 'java fresher', location: 'india' };
const BASE_URL = 'https://www.simplyhired.co.in';

async function getHeaders() {
  console.log('\n[SimplyHired] Opening simplyhired.co.in to capture headers...');
  let browser;
  try {
    browser = await launchBrowser();

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1366, height: 768 },
      locale: 'en-IN',
      timezoneId: 'Asia/Kolkata',
    });

    const page = await context.newPage();

    let capturedHeaders = null;
    let headerResolver;
    const headerPromise = new Promise(resolve => { headerResolver = resolve; });

    page.on('response', (response) => {
      const url = response.url();
      if (url.includes('simplyhired.co.in') && url.includes('/search')) {
        const hdrs = response.request().headers();
        const cookies = response.request().headerValue('cookie');
        if (!capturedHeaders) {
          capturedHeaders = {
            ...hdrs,
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          };
          headerResolver(capturedHeaders);
        }
      }
    });

    const runSteps = async () => {
      try {
        await safeGoto(page, 'Loading SimplyHired homepage', `${BASE_URL}/`);
        await page.waitForTimeout(3000);

        await safeGoto(page, 'Loading search page', `${BASE_URL}/search?q=java+fresher&l=india`);
        await page.waitForTimeout(5000);
        console.log('[SimplyHired] Search page loaded.');

        for (let i = 0; i < 3; i++) {
          try { await page.mouse.wheel(0, 800); } catch (e) { /* ignore */ }
          await page.waitForTimeout(2000);
        }
      } catch (err) {
        if (!err.message.includes('closed')) {
          console.log(`[SimplyHired] Navigation error: ${err.message}`);
        }
      }
    };

    await Promise.race([headerPromise, runSteps()]);
    await browser.close();
    browser = null;

    if (capturedHeaders) {
      console.log('[SimplyHired] Headers captured successfully.');
    } else {
      console.log('[SimplyHired] Header capture complete (no specific API headers needed).');
    }

    return capturedHeaders || { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };
  } catch (err) {
    console.log(`[SimplyHired] Error: ${err.message}`);
    if (browser) await browser.close().catch(() => { });
    return { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };
  }
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

      const jobCards = document.querySelectorAll('[class*="jobcard"]');
      if (jobCards.length > 0) {
        jobCards.forEach(card => {
          try {
            const titleEl = card.querySelector('[class*="title"]') || card.querySelector('h2, h3, a[class*="title"]');
            const companyEl = card.querySelector('[class*="company"]') || card.querySelector('[class*="employer"]');
            const locationEl = card.querySelector('[class*="location"]') || card.querySelector('[class*="loc"]');
            const salaryEl = card.querySelector('[class*="salary"]') || card.querySelector('[class*="pay"]');
            const linkEl = card.querySelector('a[href*="/job/"]') || card.querySelector('a[href*="-jobs"]');
            const dateEl = card.querySelector('[class*="date"]') || card.querySelector('time') || card.querySelector('[class*="age"]');

            const title = titleEl ? titleEl.textContent.trim() : '';
            const company = companyEl ? companyEl.textContent.trim() : '';
            const location = locationEl ? locationEl.textContent.trim() : '';
            const salary = salaryEl ? salaryEl.textContent.trim() : '';
            const url = linkEl ? linkEl.href : '';
            const dateText = dateEl ? dateEl.textContent.trim() : '';

            if (title && company) {
              results.push({ title, company, location, salary, url, dateText });
            }
          } catch (e) { /* skip malformed card */ }
        });
      }

      const serpCards = document.querySelectorAll('[data-testid="searchSerpJobCard"]');
      if (serpCards.length > 0) {
        serpCards.forEach(card => {
          try {
            const titleEl = card.querySelector('[data-testid="jobTitle"]') || card.querySelector('a[class*="title"]');
            const companyEl = card.querySelector('[data-testid="companyName"]') || card.querySelector('[class*="company"]');
            const locationEl = card.querySelector('[data-testid="location"]') || card.querySelector('[class*="location"]');
            const salaryEl = card.querySelector('[data-testid="salary"]') || card.querySelector('[class*="salary"]');
            const linkEl = card.querySelector('a[href]');
            const dateEl = card.querySelector('[data-testid="age"]') || card.querySelector('[class*="date"]');

            const title = titleEl ? titleEl.textContent.trim() : '';
            const company = companyEl ? companyEl.textContent.trim() : '';
            const location = locationEl ? locationEl.textContent.trim() : '';
            const salary = salaryEl ? salaryEl.textContent.trim() : '';
            const url = linkEl ? linkEl.href : '';
            const dateText = dateEl ? dateEl.textContent.trim() : '';

            if (title && company) {
              results.push({ title, company, location, salary, url, dateText });
            }
          } catch (e) { /* skip */ }
        });
      }

      return results;
    });

    await browser.close();
    browser = null;

    if (jobs.length === 0) {
      console.log('[SimplyHired] No jobs found. Trying alternative extraction via page content...');

      const bodyText = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a[href*="/job/"]'));
        return links.slice(0, 30).map(a => ({ href: a.href, text: a.textContent.trim() }));
      });

      if (bodyText.length === 0) {
        console.log('[SimplyHired] No job links found in page. Search page may have changed.');
        return true;
      }

      console.log(`[SimplyHired] Found ${bodyText.length} potential job links via fallback.`);
      for (const link of bodyText) {
        if (link.text && link.text.length > 3) {
          jobs.push({ title: link.text, company: 'Unknown', location: location, url: link.href, dateText: '' });
        }
      }
    }

    console.log(`[SimplyHired] Found ${jobs.length} jobs.`);

    const walkinRe = makeWalkinRe();
    for (const job of jobs) {
      const title = job.title || 'Unknown';
      const company = job.company || 'Unknown';
      const loc = job.location || location;
      const url = job.url || '';
      const salary = job.salary || '';

      const dedupKey = `${title}|${company}|${url}`;
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
          isWalkin: walkinRe.test(title + ' ' + company + ' ' + loc + ' ' + salary),
          salary: salary || undefined,
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
