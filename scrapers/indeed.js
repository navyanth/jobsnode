const crypto = require('crypto');
const sheets = require('../sheets');
const { notify } = require('../notifier');
const { launchBrowser, makeWalkinRe } = require('./base-scraper');

const NAME = 'indeed';
const DEFAULT_SETTINGS = { keyword: 'java developer', location: 'india' };

async function getHeaders() {
  return { ready: true, ts: Date.now() };
}

async function scrape() {
  const settings = sheets.getScraperSettings(NAME);
  const keyword = settings.keyword || DEFAULT_SETTINGS.keyword;
  const location = settings.location || DEFAULT_SETTINGS.location;

  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${timestamp}] [Indeed] Scraping for '${keyword}' in '${location}'...`);

  let browser;
  try {
    browser = await launchBrowser();
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1366, height: 768 },
      locale: 'en-US',
    });
    const page = await context.newPage();

    const searchUrl = `https://in.indeed.com/jobs?q=${encodeURIComponent(keyword)}&l=${encodeURIComponent(location)}`;
    console.log(`[Indeed] Loading: ${searchUrl}`);

    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);

    const jobCards = await page.evaluate(() => {
      const results = [];
      const links = document.querySelectorAll('a.jcs-JobTitle');
      links.forEach(a => {
        const jk = a.getAttribute('data-jk') || '';
        const title = (a.getAttribute('title') || a.textContent).trim();
        const href = a.getAttribute('href') || '';
        const url = href.startsWith('http') ? href : 'https://in.indeed.com' + href;
        let company = '';
        const cmpMatch = href.match(/[?&]cmp=([^&]+)/);
        if (cmpMatch) {
          company = decodeURIComponent(cmpMatch[1].replace(/\+/g, ' ')).replace(/-/g, ' ');
        }
        if (!company) {
          const card = a.closest('[class*="mosaic-provider-jobcards"]') || a.closest('div.css-pt3vth');
          if (card) {
            const parts = card.textContent.match(/View all (.+?) jobs/);
            if (parts) company = parts[1].trim();
          }
        }
        if (title && jk) {
          results.push({ title, company, url, jk });
        }
      });
      return results;
    });

    console.log(`[Indeed] Found ${jobCards.length} job listings on search page.`);
    const walkinRe = makeWalkinRe();
    let saved = 0;

    for (const card of jobCards) {
      const hash = makeHash(card.title, card.company, card.url);
      if (!sheets.isNewJob(hash)) continue;

      let company = card.company;
      let locationText = 'India';

      try {
        await page.goto(`https://in.indeed.com/viewjob?jk=${card.jk}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(3000);

        const detail = await page.evaluate(() => {
          const compEl = document.querySelector('[data-testid="inlineHeader-companyName"] a, [data-company-name="true"] a');
          const locEl = document.querySelector('[data-testid="inlineHeader-companyLocation"], [data-testid="text-location"]');
          return {
            company: compEl ? compEl.textContent.trim() : '',
            location: locEl ? locEl.textContent.trim() : '',
          };
        });

        company = detail.company || company || 'Unknown';
        locationText = detail.location || 'India';
      } catch (err) {
        console.log(`[Indeed] Detail page error for ${card.title}: ${err.message}`);
        company = company || 'Unknown';
      }

      const isWalkin = walkinRe.test(card.title) || walkinRe.test(company);

      const jobData = {
        title: card.title,
        company,
        location: locationText,
        url: card.url,
        source: NAME,
        hash,
        date: new Date().toISOString(),
        isWalkin,
      };

      console.log(`[Indeed] NEW: ${card.title} @ ${company} [${locationText}]`);
      await notify(jobData);
      await sheets.saveJob(jobData);
      saved++;

      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2000);
    }

    await browser.close();
    console.log(`[Indeed] Done. Saved ${saved} new jobs out of ${jobCards.length} listings.`);
    return true;
  } catch (err) {
    console.log(`[Indeed] Error: ${err.message}`);
    if (browser) await browser.close().catch(() => { });
    return false;
  }
}

function makeHash(title, company, url) {
  const jk = url.match(/[?&]jk=([^&]+)/);
  const stableId = jk ? jk[1] : url.trim();
  const raw = `${title.toLowerCase().trim()}|${(company || '').toLowerCase().trim()}|${stableId}`;
  return crypto.createHash('md5').update(raw).digest('hex');
}

function getDefaultSettings() {
  return { ...DEFAULT_SETTINGS };
}

module.exports = {
  name: NAME,
  getHeaders,
  scrape,
  getDefaultSettings,
};
