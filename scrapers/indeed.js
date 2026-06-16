const crypto = require('crypto');
const sheets = require('../sheets');
const { notify } = require('../notifier');
const { acquireBrowser, releaseBrowser } = require('./base-scraper');

const NAME = 'indeed';
const DEFAULT_SETTINGS = { enabled: '1', keyword: 'software developer', location: 'hyderabad', locations: 'hyderabad,bangalore,chennai', jobtype: 'fresher', dateposted: '1', sc: '0kf%3Aattr%287EQCZ%29%3B' };
const SEARCH_URL = 'https://in.indeed.com/jobs?q=$$KEYWORD&l=$$LOCATION';

let locationIndex = 0;

async function getHeaders() {
  const browser = await acquireBrowser();
  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      viewport: { width: 1366, height: 768 },
      locale: 'en-US',
    });
    const p = await context.newPage();
    await p.goto('https://in.indeed.com', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await p.waitForTimeout(5000);

    const cookies = await p.context().cookies();
    const userAgent = await p.evaluate(() => navigator.userAgent);

    console.log(`[Indeed] Session ready: ${cookies.length} cookies, UA: ${userAgent.slice(0, 50)}`);
    return { ready: true, cookies, userAgent, ts: Date.now() };
  } catch (err) {
    console.log(`[Indeed] getHeaders error: ${err.message}`);
    return null;
  } finally {
    try { await browser.close(); } catch { }
    releaseBrowser();
  }
}

async function scrape(headers) {
  const settings = sheets.getScraperSettings(NAME);
  const keyword = settings.keyword || DEFAULT_SETTINGS.keyword;
  const jobtype = settings.jobtype || DEFAULT_SETTINGS.jobtype;
  const dateposted = settings.dateposted || DEFAULT_SETTINGS.dateposted;
  const sc = settings.sc || DEFAULT_SETTINGS.sc;

  let location = settings.location || DEFAULT_SETTINGS.location;
  const locations = ((settings.locations || DEFAULT_SETTINGS.locations) || '').split(',').map(s => s.trim()).filter(Boolean);
  if (locations.length) {
    locationIndex = locationIndex % locations.length;
    location = locations[locationIndex];
    locationIndex++;
  }

  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${timestamp}] [Indeed] Scraping '${keyword}' in '${location}'${jobtype ? ' [' + jobtype + ']' : ''}${dateposted ? ' (last ' + dateposted + 'd)' : ''}...`);

  const browser = await acquireBrowser();
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    viewport: { width: 1366, height: 768 },
    locale: 'en-US',
  });
  const p = await context.newPage();
  try {
    if (headers?.cookies) {
      try { await p.context().addCookies(headers.cookies); } catch { }
    }

    let url = SEARCH_URL
      .replace('$$KEYWORD', encodeURIComponent(keyword))
      .replace('$$LOCATION', encodeURIComponent(location));
    if (jobtype) url += '&jt=' + encodeURIComponent(jobtype);
    if (dateposted) url += '&fromage=' + encodeURIComponent(dateposted);
    if (sc) url += '&sc=' + sc;
    console.log(`[Indeed] URL: ${url}`);
    console.log(`[Indeed] Loading search page...`);
    await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await p.waitForTimeout(5000);

    for (let i = 0; i < 3; i++) {
      await p.evaluate(() => window.scrollBy(0, 800));
      await p.waitForTimeout(1500);
    }
    await p.evaluate(() => window.scrollTo(0, 0));
    await p.waitForTimeout(1000);

    console.log(`[Indeed] Page title: ${await p.title()}`);

    try {
      await p.waitForFunction(() => window.mosaic?.providerData?.['mosaic-provider-jobcards']?.metaData?.mosaicProviderJobCardsModel?.results?.length, { timeout: 15000 });
      console.log('[Indeed] Mosaic data loaded.');
    } catch {
      console.log('[Indeed] Mosaic data wait timed out, trying DOM extraction...');
    }

    const results = await extractPageResults(p, url);

    if (!results || results.length === 0) {
      console.log('[Indeed] No results — may need fresh headers.');
      return false;
    }

    const walkinRe = /\b(walk[- ]?in)\b/i;
    let saved = 0;

    for (const job of results) {
      const hash = makeHash(job.title, job.company, job.jobkey);
      if (!sheets.isNewJob(hash)) continue;

      const jobDate = job.pubDate
        ? new Date(job.pubDate).toISOString()
        : new Date().toISOString();

      const isWalkin = walkinRe.test(job.title) || walkinRe.test(job.company) || walkinRe.test(job.snippet || '');

      let salaryText = '';
      if (job.salary) {
        try {
          const s = typeof job.salary === 'string' ? JSON.parse(job.salary) : job.salary;
          if (s.text) salaryText = s.text;
        } catch { salaryText = String(job.salary); }
      }

      const jobUrl = job.url || `https://in.indeed.com/viewjob?jk=${job.jobkey}`;
      const jobData = {
        title: job.title,
        company: job.company,
        location: job.location + (job.remoteText ? ` (${job.remoteText})` : ''),
        url: jobUrl,
        source: NAME,
        hash,
        date: jobDate,
        isWalkin,
        salary: salaryText,
        snippet: cleanupSnippet(job.snippet),
      };

      console.log(`[Indeed] NEW: ${job.title} @ ${job.company} [${job.location}]${salaryText ? ' ' + salaryText : ''}`);
      await notify(jobData);
      await sheets.saveJob(jobData);
      saved++;
    }

    console.log(`[Indeed] Done. ${saved} new / ${results.length} total.`);
    return true;
  } catch (err) {
    console.log(`[Indeed] Error: ${err.message}`);
    return false;
  } finally {
    try { await browser.close(); } catch { }
    releaseBrowser();
  }
}

async function extractPageResults(page, baseUrl) {
  const results = await page.evaluate((baseUrl) => {
    // try mosaic data first
    try {
      const model = window.mosaic?.providerData?.['mosaic-provider-jobcards']?.metaData?.mosaicProviderJobCardsModel;
      if (model?.results?.length) {
        return model.results.map(r => ({
          title: r.displayTitle || r.normTitle || r.title || '',
          company: r.company || r.truncatedCompany || '',
          location: r.formattedLocation || '',
          salary: r.extractedSalary || '',
          snippet: r.snippet || '',
          relativeTime: r.formattedRelativeTime || '',
          pubDate: r.pubDate || r.createDate || 0,
          remote: r.remoteWorkModel?.type || '',
          remoteText: r.remoteWorkModel?.text || '',
          sponsored: !!r.sponsored,
          jobkey: r.jobkey || '',
          url: r.viewJobLink
            ? 'https://in.indeed.com' + r.viewJobLink
            : r.link
              ? 'https://in.indeed.com' + r.link
              : r.jobkey
                ? 'https://in.indeed.com/viewjob?jk=' + r.jobkey
                : baseUrl,
          companyRating: r.companyRating || 0,
          companyReviewCount: r.companyReviewCount || 0,
          urgentlyHiring: !!r.urgentlyHiring,
          jobTypes: r.taxonomyAttributes || [],
          source: 'mosaic',
        }));
      }
    } catch {}

    // fallback: extract from DOM
    const cards = document.querySelectorAll('[data-jk]');
    return Array.from(cards).map(card => {
      const jk = card.getAttribute('data-jk') || '';
      const titleEl = card.querySelector('.jobTitle span') || card.querySelector('[id^="jobTitle-"]');
      const companyEl = card.querySelector('[data-testid="company-name"]');
      const locationEl = card.querySelector('[data-testid="text-location"]');
      const salaryEl = card.querySelector('[data-testid="attribute_snippet_testid"]');
      const snippetEl = card.querySelector('.job-snippet') || card.querySelector('[class*="snippet"]');
      return {
        title: titleEl?.textContent?.trim() || '',
        company: companyEl?.textContent?.trim() || '',
        location: locationEl?.textContent?.trim() || '',
        salary: salaryEl?.textContent?.trim() || '',
        snippet: snippetEl?.textContent?.trim() || '',
        jobkey: jk,
        url: jk ? 'https://in.indeed.com/viewjob?jk=' + jk : baseUrl,
        source: 'dom',
      };
    }).filter(j => j.title);
  }, baseUrl);

  if (results.length) {
    const src = results[0].source;
    console.log(`[Indeed] Extracted ${results.length} results via ${src}`);
    // remove internal source field
    return results.map(({ source, ...r }) => r);
  }
  return [];
}

function cleanupSnippet(snippet) {
  if (!snippet) return '';
  return snippet.replace(/<[^>]*>/g, ' ').replace(/&[^;]+;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
}

function makeHash(title, company, jobkey) {
  const raw = `${title.toLowerCase().trim()}|${(company || '').toLowerCase().trim()}|${jobkey}`;
  return crypto.createHash('md5').update(raw).digest('hex');
}

function getDefaultSettings() {
  return { ...DEFAULT_SETTINGS };
}

function getSettingsSchema() {
  return [
    {
      key: 'enabled', label: 'Enabled', type: 'select', options: [
        { value: '1', label: 'Yes' },
        { value: '0', label: 'No' },
      ],
    },
    { key: 'keyword', label: 'Keyword', type: 'text', placeholder: 'e.g. software developer' },
    { key: 'location', label: 'Location', type: 'text', placeholder: 'e.g. hyderabad' },
    { key: 'locations', label: 'Locations (cycle through)', type: 'text', placeholder: 'e.g. hyderabad,bangalore,chennai' },
    {
      key: 'jobtype', label: 'Job Type', type: 'select', options: [
        { value: '', label: 'Any' },
        { value: 'fresher', label: 'Fresher' },
        { value: 'fulltime', label: 'Full-time' },
        { value: 'parttime', label: 'Part-time' },
        { value: 'contract', label: 'Contract' },
        { value: 'internship', label: 'Internship' },
        { value: 'temporary', label: 'Temporary' },
      ],
    },
    { key: 'sc', label: 'SC Filter Param', type: 'text', placeholder: 'e.g. 0kf%3Aattr%287EQCZ%29%3B' },
    {
      key: 'dateposted', label: 'Date Posted', type: 'select', options: [
        { value: '', label: 'Any' },
        { value: '1', label: 'Last 24 hours' },
        { value: '3', label: 'Last 3 days' },
        { value: '7', label: 'Last 7 days' },
        { value: '14', label: 'Last 14 days' },
      ],
    },
  ];
}

module.exports = {
  name: NAME,
  getHeaders,
  scrape,
  getDefaultSettings,
  getSettingsSchema,
};
