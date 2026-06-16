# Release 1 — Multi-Scraper Support

## New Features
- **Multi-scraper framework** — extensible scraper manager supporting multiple job sites
- **Naukri scraper** — scrapes Naukri.com using Playwright with stealth mode, captures dynamic API headers, and polls for new jobs
- **Indeed scraper** — placeholder ready for future implementation
- **Per-scraper settings** — each scraper can have its own keyword, location, and experience configuration stored in Google Sheets

## Improvements
- Refactored server.js to use modular scraper manager (`scrapers/index.js`)
- Extracted base scraper utilities (browser launch, safe goto, fetch with retry)
- Google Sheets settings layer now supports per-scraper prefix keys
- Walk-in job detection with highlighted Telegram notifications
- Health-check self-ping to keep Render service awake

## Infrastructure
- Deployed on Render with Chromium (Playwright) for browser automation
- Google Apps Script backend for persistent storage (no service account required)
- Telegram + Email notifications on new job discovery
