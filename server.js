/**
 * Job Monitor — Node.js / Express server
 *
 * Serves a static frontend, runs multiple site scrapers in the background,
 * and stores everything in Google Sheets.
 */

require('dotenv').config();

const express = require('express');
const path = require('path');
const sheets = require('./sheets');
const { notify } = require('./notifier');
const scraperManager = require('./scrapers');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── API Endpoints ─────────────────────────────────────────────────────────────

app.get('/api/settings', (req, res) => {
  res.json(sheets.getScraperSettings('naukri'));
});

app.post('/api/settings', async (req, res) => {
  try {
    const { keyword, location, experience } = req.body;
    await sheets.saveScraperSettings('naukri', { keyword, location, experience });
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
  const running = scraperManager.isRunning();
  res.json({ status: running ? 'running' : 'stopped' });
});

app.post('/api/start', (req, res) => {
  if (scraperManager.isRunning()) return res.json({ status: 'running' });
  scraperManager.start();
  res.json({ status: 'started' });
});

app.post('/api/stop', (req, res) => {
  scraperManager.stop();
  res.json({ status: 'stopped' });
});

app.post('/api/notify-all', async (req, res) => {
  try {
    const jobs = await sheets.getJobs(200);
    let sent = 0;
    for (const job of jobs) {
      await notify(job);
      sent++;
    }
    res.json({ status: 'ok', sent });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/clear-db', async (req, res) => {
  try {
    await sheets.clearJobs();
    res.json({ status: 'cleared' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/scrapers', (req, res) => {
  res.json(scraperManager.getStatus());
});

app.get('/api/scrapers/settings', (req, res) => {
  const scrapers = scraperManager.getScrapers();
  const result = scrapers.map(s => {
    const merged = { ...s.defaultSettings, ...sheets.getScraperSettings(s.name) };
    for (const key of Object.keys(s.defaultSettings)) {
      if (merged[key] === '') merged[key] = s.defaultSettings[key];
    }
    return {
      name: s.name,
      running: s.running,
      settings: merged,
      settingsSchema: s.settingsSchema,
    };
  });
  res.json(result);
});

app.get('/api/settings/:name', (req, res) => {
  const settings = sheets.getScraperSettings(req.params.name);
  res.json(settings);
});

app.post('/api/settings/:name', async (req, res) => {
  try {
    await sheets.saveScraperSettings(req.params.name, req.body);
    res.json({ status: 'success' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/scrapers/:name/start', (req, res) => {
  scraperManager.start(req.params.name);
  res.json({ status: 'started' });
});

app.post('/api/scrapers/:name/stop', (req, res) => {
  scraperManager.stop(req.params.name);
  res.json({ status: 'stopped' });
});

// ── Health Check API ─────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Fallback — serve index.html for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Self-Ping / Health Check Ping ─────────────────────────────────────────────
function startSelfPing() {
  const baseUrl = process.env.BASE_URL;
  const intervalSec = parseInt(process.env.HEALTH_CHECK_INTERVAL, 10) || 20;
  const intervalMs = intervalSec * 1000;

  if (!baseUrl) {
    console.log('[Health Check] BASE_URL not configured. Self-ping disabled.');
    return;
  }

  console.log(`[Health Check] Self-ping active. Target: ${baseUrl}/api/health every ${intervalSec}s`);

  setInterval(async () => {
    try {
      const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/health`);
      if (res.ok) {
        console.log(`[Health Check] Self-ping successful: ${res.status}`);
      } else {
        console.log(`[Health Check] Self-ping failed with status: ${res.status}`);
      }
    } catch (err) {
      console.log(`[Health Check] Self-ping error: ${err.message}`);
    }
  }, intervalMs);
}

// ── Startup ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;

async function main() {
  try {
    await sheets.init();
    scraperManager.init({ autoStart: true });

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`\nServer running on http://localhost:${PORT}\n`);
      scraperManager.start();
      startSelfPing();
    });
  } catch (err) {
    console.error('Fatal startup error:', err);
    process.exit(1);
  }
}

main();

