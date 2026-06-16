# Release 3 — SimplyHired Scraper & Settings Isolation

## Summary
New SimplyHired scraper using the Next.js `_next/data` JSON API, per-scraper settings isolation (no global fallback), and stale-header recovery when the API returns non-200 or times out.

## Changes (4 files)

### scrapers/simplyhired.js (new implementation)
- **Next.js JSON API**: Extracts buildId from `__NEXT_DATA__` on homepage, then calls `_next/data/{buildId}/en-IN/search.json?q=...&l=...&t=1`
- **Comma-Separated Iteration**: Cycles through every combination of keywords and locations
- **Stale-Header Recovery**: Non-200 or timeout returns `false`, triggering header refresh on next tick
- **Settings Schema**: Exposes `getSettingsSchema()` with `enabled`, `keyword`, and `location` fields

### sheets.js
- **Per-Scraper Isolation**: `getScraperSettings()` now returns only `{name}_` prefixed keys — no global fallback to unprefixed keys

### scrapers/index.js
- **Default Merge**: Manager `tick()` merges `scraper.getDefaultSettings()` with Sheet settings, so code defaults (e.g., `enabled: '0'`) are respected even before Sheet entries exist

## Configuration
Per-scraper settings in Google Sheets with prefix `simplyhired_`:
- `simplyhired_enabled` — `1` (enabled) or `0` (disabled, default)
- `simplyhired_keyword` — Comma-separated keywords (default: `software developer fresher`)
- `simplyhired_location` — Comma-separated locations (default: `bangalore`)
