const crypto = require('crypto');
const sheets = require('../sheets');
const { notify } = require('../notifier');
const { fetchWithRetry, makeWalkinRe } = require('./base-scraper');

const NAME = 'simplyhired';
const DEFAULT_SETTINGS = { enabled: '0', keyword: 'software developer fresher', location: 'bangalore' };
const BASE_URL = 'https://www.simplyhired.co.in';

function extractJobsFromHtml(html) {
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/);
  if (!match) return null;
  try {
    const data = JSON.parse(match[1]);
    return data.props?.pageProps?.jobs || data.pageProps?.jobs || null;
  } catch {
    return null;
  }
}

async function scrape() {
  const settings = sheets.getScraperSettings(NAME);
  const keywords = (settings.keyword || DEFAULT_SETTINGS.keyword).split(',').map(s => s.trim()).filter(Boolean);
  const locations = (settings.location || DEFAULT_SETTINGS.location).split(',').map(s => s.trim()).filter(Boolean);

  const walkinRe = makeWalkinRe();
  let anySuccess = false;

  for (const keyword of keywords) {
    for (const location of locations) {
      const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
      console.log(`[${timestamp}] [SimplyHired] Polling '${keyword}' in '${location}'...`);

      const q = encodeURIComponent(keyword);
      const l = encodeURIComponent(location);
      const pageUrl = `${BASE_URL}/search?q=${q}&l=${l}`;

      const headers = {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.5',
        'referer': `${BASE_URL}/`,
      };

      let res;
      try {
        res = await fetchWithRetry(pageUrl, headers, { timeout: 30000, retries: 3 });
      } catch (err) {
        if (err.name === 'TimeoutError' || err.message.includes('timeout')) {
          console.log('[SimplyHired] Timeout fetching search page.');
          return false;
        }
        throw err;
      }

      if (res.status !== 200) {
        console.log(`[SimplyHired] Got ${res.status} from search page.`);
        console.log(`[SimplyHired] curl -v "${pageUrl}" -H "user-agent: ${headers['user-agent']}" -H "accept: ${headers['accept']}" -H "accept-language: ${headers['accept-language']}" -H "referer: ${headers['referer']}"`);
        return false;
      }

      const html = await res.text();
      const jobs = extractJobsFromHtml(html);

      if (!jobs || !jobs.length) {
        console.log(`[SimplyHired] No jobs found for '${keyword}' in '${location}'.`);
        continue;
      }

      anySuccess = true;
      console.log(`[SimplyHired] Got ${jobs.length} jobs for '${keyword}' in '${location}'.`);

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
    }
  }

  return anySuccess;
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
    { key: 'location', label: 'Location', type: 'text', placeholder: 'e.g. bangalore' },
  ];
}

module.exports = {
  name: NAME,
  scrape,
  getDefaultSettings,
  getSettingsSchema,
};
