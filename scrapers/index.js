const naukri = require('./naukri');
const indeed = require('./indeed');
const simplyhired = require('./simplyhired');
const sheets = require('../sheets');

const registered = [naukri, indeed, simplyhired];

const state = {};
let runOnStart = true;

function init({ autoStart = true } = {}) {
  runOnStart = autoStart;
  for (const scraper of registered) {
    state[scraper.name] = {
      running: false,
      stopRequested: false,
      timer: null,
      headers: null,
    };
  }
}

function getScrapers() {
  return registered.map(s => ({
    name: s.name,
    running: state[s.name]?.running || false,
    defaultSettings: s.getDefaultSettings ? s.getDefaultSettings() : {},
    settingsSchema: s.getSettingsSchema ? s.getSettingsSchema() : null,
  }));
}

function getStatus() {
  return registered.map(s => ({
    name: s.name,
    running: state[s.name]?.running || false,
  }));
}

function isRunning(name) {
  if (name) return state[name]?.running || false;
  return registered.some(s => state[s.name]?.running);
}

async function tick(scraper) {
  const st = state[scraper.name];
  if (!st || st.stopRequested) {
    if (st) st.running = false;
    return;
  }

  const defaults = scraper.getDefaultSettings ? scraper.getDefaultSettings() : {};
  const sSettings = { ...defaults, ...sheets.getScraperSettings(scraper.name) };
  if (sSettings.enabled === '0') {
    console.log(`[Manager] ${scraper.name}: disabled via settings, skipping.`);
    const intervalMs = (parseInt(process.env.SCRAPE_INTERVAL_SEC, 10) || 900) * 1000;
    st.timer = setTimeout(() => tick(scraper), intervalMs);
    return;
  }

  if (!st.headers) {
    console.log(`[Manager] ${scraper.name}: capturing headers...`);
    st.headers = await scraper.getHeaders();
    if (!st.headers) {
      console.log(`[Manager] ${scraper.name}: failed to capture headers, retrying...`);
      const intervalMs = (parseInt(process.env.SCRAPE_INTERVAL_SEC, 10) || 900) * 1000;
      st.timer = setTimeout(() => tick(scraper), intervalMs);
      return;
    }
  }

  try {
    const ok = await scraper.scrape(st.headers);
    if (!ok) st.headers = null;
  } catch (err) {
    console.log(`[Manager] ${scraper.name}: error - ${err.message}`);
    if (!err.message.includes('timeout') && err.name !== 'TimeoutError') {
      st.headers = null;
    }
  }

  const intervalMs = (parseInt(process.env.SCRAPE_INTERVAL_SEC, 10) || 900) * 1000;
  st.timer = setTimeout(() => tick(scraper), intervalMs);
}

function start(name) {
  if (name) {
    const scraper = registered.find(s => s.name === name);
    if (!scraper) return;
    const st = state[scraper.name];
    if (st.running) return;
    st.running = true;
    st.stopRequested = false;
    setImmediate(() => tick(scraper));
  } else {
    for (const scraper of registered) {
      const st = state[scraper.name];
      if (st.running) continue;
      st.running = true;
      st.stopRequested = false;
      setImmediate(() => tick(scraper));
    }
  }
}

function stop(name) {
  if (name) {
    const st = state[name];
    if (!st) return;
    st.stopRequested = true;
    if (st.timer) {
      clearTimeout(st.timer);
      st.timer = null;
    }
    st.running = false;
  } else {
    for (const scraper of registered) {
      const st = state[scraper.name];
      st.stopRequested = true;
      if (st.timer) {
        clearTimeout(st.timer);
        st.timer = null;
      }
      st.running = false;
    }
  }
}

function getAutoStart() {
  return runOnStart;
}

module.exports = {
  init,
  getScrapers,
  getStatus,
  isRunning,
  start,
  stop,
  getAutoStart,
};
