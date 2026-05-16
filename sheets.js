/**
 * Google Sheets Database Layer — via Google Apps Script Web App
 *
 * No service account or Google Cloud project required.
 * All reads/writes go through a deployed Apps Script URL.
 */

const crypto = require('crypto');

const SCRIPT_URL = process.env.APPS_SCRIPT_URL;

// ── In-memory cache ───────────────────────────────────────────────────────────
let jobHashCache = new Set();
let settingsCache = { keyword: 'java fresher', location: 'india', experience: '0' };

// ── Helpers ───────────────────────────────────────────────────────────────────

async function safeJson(res) {
  const text = await res.text();
  if (text.trim().startsWith('<')) {
    // Google returned an HTML page — usually a permissions/auth issue
    const isLoginPage = text.includes('accounts.google.com') || text.includes('signin');
    if (isLoginPage) {
      throw new Error(
        'Apps Script returned a Google login page.\n' +
        '  ➜ Fix: Re-deploy the script with "Who has access: Anyone" and make sure you clicked "Authorize" during deployment.'
      );
    }
    throw new Error(
      `Apps Script returned HTML instead of JSON (status ${res.status}).\n` +
      `  ➜ Raw response (first 300 chars): ${text.slice(0, 300)}`
    );
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Apps Script returned invalid JSON: ${text.slice(0, 200)}`);
  }
}

async function scriptGet(action) {
  const url = `${SCRIPT_URL}?action=${action}`;
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(20000),
  });
  const data = await safeJson(res);
  if (data && data.error) throw new Error(`Apps Script error: ${data.error}`);
  return data;
}

async function scriptPost(body) {
  const res = await fetch(SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'follow',
    signal: AbortSignal.timeout(20000),
  });
  const data = await safeJson(res);
  if (data && data.error) throw new Error(`Apps Script error: ${data.error}`);
  return data;
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  if (!SCRIPT_URL) {
    console.error('[Sheets] ❌ APPS_SCRIPT_URL is not set. Please deploy the Apps Script and set the URL in .env');
    process.exit(1);
  }

  console.log('[Sheets] Connecting to Google Sheets via Apps Script...');

  // Load caches
  await loadJobHashes();
  await loadSettings();

  console.log(`[Sheets] ✅ Ready. ${jobHashCache.size} existing job hashes loaded.`);
  console.log(`[Sheets] Settings: ${JSON.stringify(settingsCache)}`);
}

// ── Hash ──────────────────────────────────────────────────────────────────────

function makeHash(title, company, url) {
  const raw = `${title.toLowerCase().trim()}|${company.toLowerCase().trim()}|${url.trim()}`;
  return crypto.createHash('md5').update(raw).digest('hex');
}

// ── Jobs ──────────────────────────────────────────────────────────────────────

async function loadJobHashes() {
  const hashes = await scriptGet('getHashes');
  jobHashCache = new Set(Array.isArray(hashes) ? hashes : []);
}

function isNewJob(hash) {
  return !jobHashCache.has(hash);
}

async function saveJob(job) {
  await scriptPost({ action: 'saveJob', job });
  jobHashCache.add(job.hash);
}

async function getJobs(limit = 50) {
  return await scriptGet('getJobs');
}

async function clearJobs() {
  await scriptPost({ action: 'clearJobs' });
  jobHashCache.clear();
  console.log('[Sheets] All jobs cleared.');
}

// ── Settings ──────────────────────────────────────────────────────────────────

async function loadSettings() {
  const data = await scriptGet('getSettings');
  settingsCache = { ...settingsCache, ...data };
  return { ...settingsCache };
}

function getSettings() {
  return { ...settingsCache };
}

async function saveSettings(settings) {
  settingsCache = { ...settingsCache, ...settings };
  await scriptPost({ action: 'saveSettings', settings });
  console.log(`[Sheets] Settings updated: ${JSON.stringify(settingsCache)}`);
}

module.exports = {
  init,
  makeHash,
  isNewJob,
  saveJob,
  getJobs,
  clearJobs,
  getSettings,
  loadSettings,
  saveSettings,
};
