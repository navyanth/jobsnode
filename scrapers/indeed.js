const sheets = require('../sheets');
const { makeWalkinRe } = require('./base-scraper');

const NAME = 'indeed';
const DEFAULT_SETTINGS = { keyword: 'java developer', location: 'india' };

async function getHeaders() {
  console.log('[Indeed] Header capture not yet implemented.');
  return null;
}

async function scrape(headers) {
  console.log('[Indeed] Scraping not yet implemented. Placeholder.');
  return true;
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
