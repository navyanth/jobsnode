/**
 * Job Monitor — Node.js / Express server
 *
 * Serves a static frontend, runs the Naukri scraper in the background,
 * and stores everything in Google Sheets.
 */

require('dotenv').config();

const express = require('express');
const path = require('path');
const { chromium, firefox } = require('playwright');
const sheets = require('./sheets');
const { notify } = require('./notifier');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Scraper State ─────────────────────────────────────────────────────────────

let scraperRunning = false;
let stopRequested = false;
let scraperTimer = null;

// ── Playwright: Capture Naukri Headers ────────────────────────────────────────

async function getNaukriHeaders() {
  console.log('\n[Browser] Opening naukri.com to capture headers...');
  let browser;
  try {
    // We use Playwright's Firefox. Headless Firefox bypasses Naukri's Cloudflare/Akamai
    // much better than headless Chromium, and it works flawlessly on Render.
    browser = await firefox.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
      ],
    });

    console.log(`[Browser] Using: Firefox headless`);

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
      viewport: { width: 1366, height: 768 },
      locale: 'en-US',
      timezoneId: 'Asia/Kolkata',
    });

    const page = await context.newPage();

    let capturedHeaders = null;
    let requestCount = 0;

    let headerResolver;
    const headerPromise = new Promise(resolve => { headerResolver = resolve; });

    // Capture nkparam from ANY naukri API request
    page.on('request', (request) => {
      const url = request.url();
      if (url.includes('naukri.com') && (url.includes('api') || url.includes('jobapi'))) {
        requestCount++;
        const hdrs = request.headers();
        if (hdrs['nkparam']) {
          if (!capturedHeaders) {
            console.log(`[Browser] ✅ nkparam found in: ${url.split('?')[0]}`);
            capturedHeaders = hdrs;
            headerResolver(hdrs);
          }
        }
      }
    });

    const runSteps = async () => {
      try {
        const safeGoto = async (step, url) => {
          for (let i = 1; i <= 3; i++) {
            try {
              console.log(`[Browser] ${step} (Attempt ${i})...`);
              await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
              return;
            } catch (e) {
              if (e.message.includes('closed')) throw e;
              console.log(`[Browser] ${step} error: ${e.message}`);
              await page.waitForTimeout(3000);
            }
          }
        };

        await safeGoto('Step 1: Loading homepage', 'https://www.naukri.com/');
        await page.waitForTimeout(3000);
        console.log(`[Browser] Homepage loaded. Naukri API requests so far: ${requestCount}`);

        await safeGoto('Step 2: Loading search page', 'https://www.naukri.com/java-fresher-jobs');
        await page.waitForTimeout(3000);
        console.log(`[Browser] Search page loaded. Naukri API requests so far: ${requestCount}`);

        console.log('[Browser] Step 3: Scrolling to trigger API calls...');
        for (let i = 0; i < 6; i++) {
          await page.mouse.wheel(0, 600);
          await page.waitForTimeout(2000);
        }

        await safeGoto('Step 4: Trying experience-filtered URL', 'https://www.naukri.com/java-jobs-in-india?experience=0');
        await page.waitForTimeout(4000);
        for (let i = 0; i < 5; i++) {
          await page.mouse.wheel(0, 600);
          await page.waitForTimeout(2000);
        }
      } catch (err) {
        // Ignore "Target closed" or "context closed" errors, which happen 
        // when we successfully find the headers and close the browser early.
        if (!err.message.includes('closed')) {
          console.log(`[Browser] Navigation sequence error: ${err.message}`);
        }
      }
    };

    // Wait for either the headers to be captured, or for all navigation steps to complete
    await Promise.race([headerPromise, runSteps()]);

    await browser.close();
    browser = null;

    if (capturedHeaders) {
      console.log('[Browser] ✅ Headers captured successfully.');
    } else {
      console.log(`[Browser] ❌ Header capture failed. Total naukri API requests seen: ${requestCount}`);
    }

    return capturedHeaders;
  } catch (err) {
    console.log(`[Browser] Error: ${err.message}`);
    if (browser) await browser.close().catch(() => { });
    return null;
  }
}

// ── Scraper Loop ──────────────────────────────────────────────────────────────

async function scrapeOnce(headers) {
  const settings = sheets.getSettings();
  const keyword = settings.keyword || 'java fresher';
  const location = settings.location || 'india';
  const experience = settings.experience || '0';

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
  console.log(`[${timestamp}] Polling for '${keyword}'...`);

  // Filter out pseudo-headers (HTTP/2 headers starting with ':')
  const cleanHeaders = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!k.startsWith(':')) cleanHeaders[k] = v;
  }

  let res;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      res = await fetch(apiUrl, { headers: cleanHeaders, signal: AbortSignal.timeout(30000) });
      break;
    } catch (err) {
      if (err.name === 'TimeoutError' || err.message.includes('timeout')) {
        console.log(`[Scraper] API fetch timeout (Attempt ${attempt}/3). Retrying...`);
        if (attempt === 3) throw err;
      } else {
        throw err;
      }
    }
  }

  if (res.status === 200) {
    const data = await res.json();
    const jobs = data.jobDetails || [];

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

      const hash = sheets.makeHash(title, company, url);
      let isNew = sheets.isNewJob(hash)
      if (isNew) {
        console.log(`[Browser] Found job: ${title}`);
        // Convert Naukri's createdDate timestamp to ISO string
        let jobDate = new Date().toISOString();
        if (job.createdDate) {
          jobDate = new Date(job.createdDate).toISOString();
        }

        const jobData = {
          title,
          company,
          location: loc,
          url,
          source: 'naukri',
          hash,
          date: jobDate
        };

        console.log(`      -> NEW: ${title} @ ${company} (Created: ${jobDate})`);
        await notify(jobData);
        await sheets.saveJob(jobData);
      }
    }
    return true; // success
  } else {
    console.log(`[Scraper] Got ${res.status} — headers expired, will refresh.`);
    return false; // need header refresh
  }
}

async function runScraperLoop() {
  scraperRunning = true;
  stopRequested = false;
  let headers = null;

  console.log('--- Background Scraper Started ---');

  const tick = async () => {
    if (stopRequested) {
      scraperRunning = false;
      console.log('--- Scraper Stopped ---');
      return;
    }

    // Capture headers if needed
    if (!headers) {
      headers = await getNaukriHeaders();
      if (!headers) {
        console.log('[Scraper] Failed to capture headers. Retrying in 5s...');
        scraperTimer = setTimeout(tick, 5000);
        return;
      }
    }

    try {
      const ok = await scrapeOnce(headers);
      if (!ok) headers = null; // force refresh next time
    } catch (err) {
      console.log(`[Scraper] Error: ${err.message}`);
      // Do not discard headers on network timeouts, only on auth/fatal errors
      if (!err.message.includes('timeout') && err.name !== 'TimeoutError') {
        headers = null;
      }
    }

    // Poll every 60 seconds
    scraperTimer = setTimeout(tick, 5000);
  };

  tick();
}

function stopScraper() {
  stopRequested = true;
  if (scraperTimer) {
    clearTimeout(scraperTimer);
    scraperTimer = null;
  }
  scraperRunning = false;
}

// ── API Endpoints ─────────────────────────────────────────────────────────────

app.get('/api/settings', (req, res) => {
  res.json(sheets.getSettings());
});

app.post('/api/settings', async (req, res) => {
  try {
    const { keyword, location, experience } = req.body;
    await sheets.saveSettings({ keyword, location, experience });
    res.json({ status: 'success' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/jobs', async (req, res) => {
  try {
    const jobs = await sheets.getJobs(50);
    res.json(jobs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/status', (req, res) => {
  res.json({ status: scraperRunning ? 'running' : 'stopped' });
});

app.post('/api/start', (req, res) => {
  if (scraperRunning) return res.json({ status: 'running' });
  runScraperLoop();
  res.json({ status: 'started' });
});

app.post('/api/stop', (req, res) => {
  stopScraper();
  res.json({ status: 'stopped' });
});

app.post('/api/clear-db', async (req, res) => {
  try {
    await sheets.clearJobs();
    res.json({ status: 'cleared' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fallback — serve index.html for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Startup ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;

async function main() {
  try {
    await sheets.init();

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`\n🚀 Server running on http://localhost:${PORT}\n`);
      // Auto-start scraper
      runScraperLoop();
    });
  } catch (err) {
    console.error('Fatal startup error:', err);
    process.exit(1);
  }
}

main();
