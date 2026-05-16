/**
 * Job Monitor — Node.js / Express server
 *
 * Serves a static frontend, runs the Naukri scraper in the background,
 * and stores everything in Google Sheets.
 */

require('dotenv').config();

const express = require('express');
const path = require('path');
const { chromium } = require('playwright');
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
    // Strategy: try real installed Chrome first (headless) — it bypasses Naukri's
    // bot detection unlike Playwright's bundled Chromium.
    // Falls back to bundled Chromium in non-headless mode if Chrome isn't found.
    const onRender = process.env.RENDER === 'true';

    let browser;
    let launchMode = '';

    // Attempt 1: Real Chrome headless (works on Windows/Mac where Chrome is installed)
    if (!onRender) {
      try {
        browser = await chromium.launch({
          channel: 'chrome',   // uses the actual installed Google Chrome
          headless: true,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--window-size=1366,768',
          ],
        });
        launchMode = 'real Chrome headless';
      } catch (_) {
        // Chrome not installed locally — fall through to non-headless bundled Chromium
      }
    }

    // Attempt 2: Bundled Chromium non-headless (visible window, bypasses detection locally)
    if (!browser) {
      browser = await chromium.launch({
        headless: onRender,   // headless on Render (no display), visible locally
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-blink-features=AutomationControlled',
          '--window-size=1366,768',
        ],
      });
      launchMode = onRender ? 'bundled Chromium headless (Render)' : 'bundled Chromium visible';
    }

    console.log(`[Browser] Using: ${launchMode}`);

    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1366, height: 768 },
      locale: 'en-US',
      timezoneId: 'Asia/Kolkata',
    });

    const page = await context.newPage();

    // Stealth patches
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      window.chrome = { runtime: {} };
    });

    let capturedHeaders = null;
    let requestCount = 0;

    // Capture nkparam from ANY naukri API request (not just jobapi/v3/search)
    page.on('request', (request) => {
      const url = request.url();
      if (url.includes('naukri.com') && (url.includes('api') || url.includes('jobapi'))) {
        requestCount++;
        const hdrs = request.headers();
        if (hdrs['nkparam']) {
          console.log(`[Browser] ✅ nkparam found in: ${url.split('?')[0]}`);
          capturedHeaders = hdrs;
        }
      }
    });

    // Step 1: Homepage
    console.log('[Browser] Step 1: Loading homepage...');
    await page.goto('https://www.naukri.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);
    console.log(`[Browser] Homepage loaded. Naukri API requests so far: ${requestCount}`);

    // Step 2: Search URL (networkidle ensures XHR calls complete)
    if (!capturedHeaders) {
      console.log('[Browser] Step 2: Loading search page...');
      await page.goto('https://www.naukri.com/java-fresher-jobs', {
        waitUntil: 'networkidle',
        timeout: 60000,
      });
      await page.waitForTimeout(3000);
      console.log(`[Browser] Search page loaded. Naukri API requests so far: ${requestCount}`);
    }

    // Step 3: Scroll to trigger lazy API calls
    if (!capturedHeaders) {
      console.log('[Browser] Step 3: Scrolling to trigger API calls...');
      for (let i = 0; i < 6 && !capturedHeaders; i++) {
        await page.mouse.wheel(0, 600);
        await page.waitForTimeout(2000);
      }
    }

    // Step 4: Try alternate experience-filtered URL
    if (!capturedHeaders) {
      console.log('[Browser] Step 4: Trying experience-filtered URL...');
      await page.goto('https://www.naukri.com/java-jobs-in-india?experience=0', {
        waitUntil: 'networkidle',
        timeout: 60000,
      });
      await page.waitForTimeout(4000);
      for (let i = 0; i < 5 && !capturedHeaders; i++) {
        await page.mouse.wheel(0, 600);
        await page.waitForTimeout(2000);
      }
    }

    // Step 5: Trigger search via keyboard
    if (!capturedHeaders) {
      console.log('[Browser] Step 5: Triggering search via search input...');
      try {
        const searchInput = page.locator('input[placeholder*="Skills"], input[placeholder*="Job"], #qp').first();
        await searchInput.fill('java fresher', { timeout: 5000 });
        await page.keyboard.press('Enter');
        await page.waitForTimeout(5000);
      } catch (_) { /* search box may not be found, continue */ }
    }

    await browser.close();
    browser = null;

    if (capturedHeaders) {
      console.log('[Browser] ✅ Headers captured successfully.');
    } else {
      console.log(`[Browser] ❌ Header capture failed. Total naukri API requests seen: ${requestCount}`);
      console.log('[Browser]    Naukri may be blocking headless Chrome. Retrying...');
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

  const res = await fetch(apiUrl, { headers: cleanHeaders, signal: AbortSignal.timeout(15000) });

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
      headers = null;
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
