const crypto = require('crypto');
const sheets = require('../sheets');
const { notify } = require('../notifier');
const { acquireBrowser, releaseBrowser, safeGoto, cleanHeaders, fetchWithRetry, makeWalkinRe } = require('./base-scraper');

const NAME = 'naukri';
const DEFAULT_SETTINGS = { enabled: '1', keyword: 'java fresher', location: 'india', experience: '0' };

async function getHeaders() {
  console.log('\n[Naukri] Opening naukri.com to capture headers...');
  const browser = await acquireBrowser();
  try {
    console.log(`[Naukri] Using: Chromium headless (Stealth)`);

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1366, height: 768 },
      locale: 'en-US',
      timezoneId: 'Asia/Kolkata',
    });

    const page = await context.newPage();

    let capturedHeaders = null;
    let requestCount = 0;

    let headerResolver;
    const headerPromise = new Promise(resolve => { headerResolver = resolve; });

    page.on('request', (request) => {
      const url = request.url();
      if (url.includes('naukri.com') && (url.includes('api') || url.includes('jobapi'))) {
        requestCount++;
        const hdrs = request.headers();
        if (hdrs['nkparam']) {
          if (!capturedHeaders) {
            console.log(`[Naukri] nkparam found in: ${url.split('?')[0]}`);
            capturedHeaders = hdrs;
            headerResolver(hdrs);
          }
        }
      }
    });

    const runSteps = async () => {
      try {
        await safeGoto(page, 'Step 1: Loading homepage', 'https://www.naukri.com/');
        await page.waitForTimeout(3000);
        console.log(`[Naukri] Homepage loaded. API requests so far: ${requestCount}`);

        await safeGoto(page, 'Step 2: Loading search page', 'https://www.naukri.com/java-fresher-jobs');
        await page.waitForTimeout(3000);
        console.log(`[Naukri] Search page loaded. API requests so far: ${requestCount}`);

        console.log('[Naukri] Step 3: Scrolling to trigger API calls...');
        for (let i = 0; i < 6; i++) {
          try { await page.mouse.wheel(0, 600); } catch (e) { if (e.message.includes('closed')) throw e; }
          await page.waitForTimeout(2000);
        }

        await safeGoto(page, 'Step 4: Trying experience-filtered URL', 'https://www.naukri.com/java-jobs-in-india?experience=0');
        await page.waitForTimeout(4000);
        for (let i = 0; i < 5; i++) {
          try { await page.mouse.wheel(0, 600); } catch (e) { if (e.message.includes('closed')) throw e; }
          await page.waitForTimeout(2000);
        }
      } catch (err) {
        if (!err.message.includes('closed')) {
          console.log(`[Naukri] Navigation error: ${err.message}`);
        }
      }
    };

    await Promise.race([headerPromise, runSteps()]);

    if (capturedHeaders) {
      console.log('[Naukri] Headers captured successfully.');
    } else {
      console.log(`[Naukri] Header capture failed. Total API requests: ${requestCount}`);
    }

    return capturedHeaders;
  } catch (err) {
    console.log(`[Naukri] Error: ${err.message}`);
    return null;
  } finally {
    try { await browser.close(); } catch { }
    releaseBrowser();
  }
}

async function scrape(headers) {
  const settings = sheets.getScraperSettings(NAME);
  const keyword = settings.keyword || DEFAULT_SETTINGS.keyword;
  const location = settings.location || DEFAULT_SETTINGS.location;
  const experience = settings.experience || DEFAULT_SETTINGS.experience;

  const params = new URLSearchParams({
    noOfResults: '20',
    urlType: 'search_by_key_loc',
    searchType: 'adv',
    location,
    keyword,
    sort: 'f',
    pageNo: '1',
    experience,
    k: keyword,
    l: location,
    nignbevent_src: 'jobsearchDeskGNB',
    seoKey: `${keyword.replace(/ /g, '-')}-jobs-in-${location}`,
    src: 'sortby',
    latLong: '',
  });

  const apiUrl = `https://www.naukri.com/jobapi/v3/search?${params}`;
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${timestamp}] [Naukri] Polling for '${keyword}'...`);

  const cleaned = cleanHeaders(headers);

  // ensure critical Naukri headers even if Playwright missed them
  const naukriDefaults = {
    'appid': '109',
    'systemid': 'Naukri',
    'clientid': 'd3skt0p',
    'gid': 'LOCATION,INDUSTRY,EDUCATION,FAREA_ROLE',
    'accept': 'application/json',
    'content-type': 'application/json',
    'referer': 'https://www.naukri.com/java-fresher-jobs',
  };
  for (const [k, v] of Object.entries(naukriDefaults)) {
    if (!cleaned[k]) cleaned[k] = v;
  }

  console.log(`[Naukri] nkparam: ${cleaned['nkparam'] ? '✓ present' : '✗ MISSING'}`);
  console.log(`[Naukri] appid: ${cleaned['appid']}, systemid: ${cleaned['systemid']}, clientid: ${cleaned['clientid']}`);
  let curlCmd = `curl -X GET "${apiUrl}"`;
  for (const [k, v] of Object.entries(cleaned)) {
    const safeVal = v.replace(/'/g, "'\\''");
    curlCmd += ` -H '${k}: ${safeVal}'`;
  }
  console.log(`[Naukri] cURL:\n${curlCmd}\n`);

  let res;
  try {
    res = await fetchWithRetry(apiUrl, cleaned, { timeout: 30000, retries: 3 });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.message.includes('timeout')) {
      console.log('[Naukri] All fetch attempts timed out.');
      return false;
    }
    throw err;
  }

  if (res.status === 200) {
    const data = await res.json();
    const jobs = data.jobDetails || [];
    const walkinRe = makeWalkinRe();

    for (const job of jobs) {
      const title = job.title || job.jobTitle || 'Unknown';
      const company = job.companyName || 'Unknown';
      const loc = Array.isArray(job.jobLocation) && job.jobLocation.length > 0
        ? job.jobLocation[0]
        : 'India';
      const jobId = job.jobId || '';
      const url = jobId
        ? `https://www.naukri.com/job-listings-${jobId}`
        : apiUrl;

      const hash = makeHash(title, company, url);
      if (sheets.isNewJob(hash)) {
        console.log(`[Naukri] Found job: ${title}`);

        let jobDate = new Date().toISOString();
        if (job.createdDate) {
          jobDate = new Date(job.createdDate).toISOString();
        }

        const isWalkin = walkinRe.test(JSON.stringify(job));

        const jobData = {
          title,
          company,
          location: loc,
          url,
          source: NAME,
          hash,
          date: jobDate,
          isWalkin,
        };

        console.log(`      -> NEW: ${title} @ ${company}`);
        await notify(jobData);
        await sheets.saveJob(jobData);
      }
    }
    return true;
  } else {
    console.log(`[Naukri] Got ${res.status} — headers expired, will refresh.`);
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

module.exports = {
  name: NAME,
  getHeaders,
  scrape,
  getDefaultSettings,
};
