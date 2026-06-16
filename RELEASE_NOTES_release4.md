# Release 4 — Restore Global Fallback in Scraper Settings

## Summary
Restored the global unprefixed key fallback in `getScraperSettings()` so that existing Sheet configurations (e.g., `keyword`, `location`) continue to work as defaults across all scrapers.

## Changes (1 file)

### sheets.js
- **Restored global fallback**: `getScraperSettings()` again falls back to unprefixed keys from settings cache when no scraper-specific key exists — ensures backward compatibility with existing Sheet data
