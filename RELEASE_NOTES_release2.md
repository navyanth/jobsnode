# Release 2 — Indeed Scraper & Multi-Scraper UI

## Summary
Complete rewrite of the Indeed scraper (Playwright-based SSR data extraction), multi-scraper manager with per-scraper settings, and overhauled UI with tabs, source filtering, and dynamic configuration forms.

## Changes (5 files, +718/−193)

### scrapers/indeed.js (new implementation)
- **SSR Data Extraction**: Reads embedded job data from `window.mosaic.providerData['mosaic-provider-jobcards'].metaData.mosaicProviderJobCardsModel.results` — no navigation to individual job pages
- **Browser Reuse**: Single Chromium instance shared across scrape cycles (recycled every 20 cycles) to minimize memory (~250 MB)
- **Filter Support**: `jobtype`, `dateposted`, and `sc` parameter support (`jt=fresher`, `fromage=1`, `sc=0kf:attr(7EQCZ)`)
- **Location Rotation**: Cycles through comma-separated locations (e.g., `hyderabad,bangalore,chennai`) on each scrape tick
- **Settings Schema**: Exposes `getSettingsSchema()` with typed fields (text + dropdown) for dynamic UI rendering

### public/index.html (rewritten UI)
- **Tab Bar**: Scraper selector tabs with running/stopped status dots
- **Dynamic Settings Form**: Renders proper form controls based on each scraper's settings schema (dropdowns for job type, date posted, enabled)
- **Source Filter**: Dropdown filter to show jobs from specific scrapers only
- **Source Badges**: Color-coded badges per source (naukri=orange, indeed=blue, linkedin=indigo)
- **Per-Scraper Controls**: Start/stop individual scrapers independently

### scrapers/index.js (multi-scraper manager)
- **Per-Scraper Start/Stop**: Start or stop individual scrapers via `/api/scrapers/:name/start` and `stop`
- **Enabled/Disabled**: Each scraper checks its `enabled` setting from Google Sheets before running
- **Settings Schema**: Exposes `defaultSettings` and `settingsSchema` via `getScrapers()` API

### server.js (API endpoints)
- `GET /api/scrapers/settings` — Returns all scrapers with merged settings (defaults + sheet values)
- `GET /api/settings/:name` — Returns settings for a specific scraper
- `POST /api/settings/:name` — Saves settings for a specific scraper
- `POST /api/scrapers/:name/start` — Start a specific scraper
- `POST /api/scrapers/:name/stop` — Stop a specific scraper

### scrapers/naukri.js
- Added `enabled: '1'` default setting for consistency

## Configuration
Set per-scraper settings in Google Sheets with prefix `{scraper}_`:
- `indeed_keyword` — Search keyword (default: `software developer`)
- `indeed_location` — Single location override
- `indeed_locations` — Comma-separated locations to cycle through (default: `hyderabad,bangalore,chennai`)
- `indeed_jobtype` — Job type filter (`fresher`, `fulltime`, etc.)
- `indeed_dateposted` — Date posted filter (`1`, `3`, `7`, `14` days)
- `indeed_sc` — Opaque Indeed filter parameter (default: `0kf:attr(7EQCZ)`)
- `indeed_enabled` — `1` (enabled) or `0` (disabled)
