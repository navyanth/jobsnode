/**
 * Google Apps Script — paste this into your Google Sheet.
 *
 * Instructions:
 *  1. Open your Google Sheet
 *  2. Extensions → Apps Script
 *  3. Delete everything, paste this entire file
 *  4. Click Save → Deploy → New Deployment
 *  5. Type: Web App
 *     Execute as: Me
 *     Who has access: Anyone
 *  6. Click Deploy → copy the Web App URL
 *  7. Put that URL in your .env as APPS_SCRIPT_URL
 */

const SHEET_JOBS = 'jobs';
const SHEET_SETTINGS = 'settings';

// ── Bootstrap ─────────────────────────────────────────────────────────────────

function getOrCreateSheet(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  }
  return sheet;
}

function ensureSheets(ss) {
  getOrCreateSheet(ss, SHEET_JOBS, ['job_hash', 'title', 'company', 'location', 'url', 'source', 'seen_at']);
  const settings = getOrCreateSheet(ss, SHEET_SETTINGS, ['key', 'value']);
  // Seed defaults if empty
  if (settings.getLastRow() <= 1) {
    settings.appendRow(['keyword', 'java fresher']);
    settings.appendRow(['location', 'india']);
    settings.appendRow(['experience', '0']);
  }
}

// ── HTTP Handlers ─────────────────────────────────────────────────────────────

function doGet(e) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheets(ss);
  const action = e.parameter.action;

  try {
    if (action === 'getJobs') {
      return jsonResponse(getJobs(ss));
    } else if (action === 'getSettings') {
      return jsonResponse(getSettings(ss));
    } else if (action === 'getHashes') {
      return jsonResponse(getHashes(ss));
    } else {
      return jsonResponse({ error: 'Unknown action' });
    }
  } catch (err) {
    return jsonResponse({ error: err.message });
  }
}

function doPost(e) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheets(ss);
  const body = JSON.parse(e.postData.contents);
  const action = body.action;

  try {
    if (action === 'saveJob') {
      saveJob(ss, body.job);
      return jsonResponse({ status: 'ok' });
    } else if (action === 'saveSettings') {
      saveSettings(ss, body.settings);
      return jsonResponse({ status: 'ok' });
    } else if (action === 'clearJobs') {
      clearJobs(ss);
      return jsonResponse({ status: 'ok' });
    } else {
      return jsonResponse({ error: 'Unknown action' });
    }
  } catch (err) {
    return jsonResponse({ error: err.message });
  }
}

function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── Jobs ──────────────────────────────────────────────────────────────────────

function initializeSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  
  // Jobs Sheet
  if (!ss.getSheetByName(SHEET_JOBS)) {
    const sheet = ss.insertSheet(SHEET_JOBS);
    sheet.appendRow(['hash', 'title', 'company', 'location', 'url', 'source', 'date']);
    sheet.getRange(1, 1, 1, 7).setFontWeight('bold').setBackground('#f3f3f3');
    sheet.setFrozenRows(1);
  }
}

function getJobs(ss) {
  const sheet = ss.getSheetByName(SHEET_JOBS);
  const data = sheet.getDataRange().getValues();
  if (data.length === 0) return [];
  
  // Hardcoded expected columns to prevent mapping issues if header row is missing
  const headers = ['hash', 'title', 'company', 'location', 'url', 'source', 'date'];
  
  // If the first row is actually a header row (checks if first column contains 'hash'), skip it
  let rows = data;
  if (data[0] && data[0][0] && data[0][0].toString().toLowerCase().includes('hash')) {
    rows = data.slice(1);
  }
  
  return rows.map(row => {
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = row[i];
    });
    return obj;
  }).reverse();
}

function getHashes(ss) {
  const sheet = ss.getSheetByName(SHEET_JOBS);
  const rows = sheet.getDataRange().getValues();
  if (rows.length <= 1) return [];
  return rows.slice(1).map(row => row[0]); // first column = job_hash
}

function saveJob(ss, job) {
  const sheet = ss.getSheetByName(SHEET_JOBS);
  // Ensure we append in the correct order: hash, title, company, location, url, source, date
  sheet.appendRow([
    job.hash || '',
    job.title || '',
    job.company || '',
    job.location || '',
    job.url || '',
    job.source || '',
    job.date || new Date().toISOString()
  ]);
}

function clearJobs(ss) {
  const sheet = ss.getSheetByName(SHEET_JOBS);
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.deleteRows(2, lastRow - 1);
  }
}

// ── Settings ──────────────────────────────────────────────────────────────────

function getSettings(ss) {
  const sheet = ss.getSheetByName(SHEET_SETTINGS);
  const rows = sheet.getDataRange().getValues().slice(1);
  const obj = {};
  rows.forEach(row => { if (row[0]) obj[row[0]] = row[1]; });
  return obj;
}

function saveSettings(ss, settings) {
  const sheet = ss.getSheetByName(SHEET_SETTINGS);
  const rows = sheet.getDataRange().getValues();
  rows.forEach((row, i) => {
    const key = row[0];
    if (i > 0 && settings[key] !== undefined) {
      sheet.getRange(i + 1, 2).setValue(settings[key]);
    }
  });
}
