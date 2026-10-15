# AGENTS.md

## Project

An automated Node.js service and Docker container that tracks and claims daily and weekly MSI Reward points, logging progress and errors.


## Commands

- `npm start` — run in cron mode: does an immediate check on startup, then schedules per `CRON_SCHEDULE`. This is the container's default (`node src/index.js`).
- `npm test` — one-shot run (`node src/index.js --run-once`), no cron scheduling. Use this for manual verification; there is no unit-test suite.
- `docker-compose up -d --build` — build from source and run.
- `docker-compose up -d` — run the published image `nightmean/msi-reward-bot:latest`.

Local runs need Chromium: set `PUPPETEER_EXECUTABLE_PATH` to a real Chrome/Chromium binary (the Dockerfile hardcodes `/usr/bin/chromium-browser` from the Alpine `chromium` package). Runs also need `data/cookies.json` and a `.env`.

## Architecture

Entire bot is one file: `src/index.js`. Flow:

1. **`runBot()`** — launches headless `puppeteer-core`, loads cookies from `data/cookies.json` into the page, navigates to `https://rewards.msi.com/`, scrapes the points value via the CSS selector `POINTS_SELECTOR` (`.kv__memberbox--info li:nth-child(2)`), parses the integer, then compares against milestones and updates state. Merely loading the authenticated page counts as the daily login — there is no explicit "claim" click.
2. **`runWithRetry()`** — wraps `runBot()` with `MAX_RETRIES` attempts and `RETRY_DELAY` backoff. Distinguishes **fatal** errors (config problems — message contains `cookies.json` or `Invalid JSON`) from **transient** errors. Fatal errors abort retries immediately.
3. **Entry point** — `--run-once` runs `runWithRetry()` and exits. Otherwise cron mode: run once immediately, then on fatal failure enter a dormant `setInterval` (keeps container alive, avoids Docker restart-loop); on transient/success failure, schedule the cron job anyway.

### Key behaviors to preserve

- **Milestone logic** (`src/index.js` loop over `MILESTONES`): notifies only when a boundary is *crossed* since last run — `lastPoints < milestone && currentPoints >= milestone`. Prevents spamming past milestones on first run. Don't change to `>=`-only.
- **State** lives in `data/state.json` (`{ lastPoints, lastRun }`) — this is how crossing detection persists between runs. The `data/` volume is the only persistence.
- **Points parsing**: text like `"My Points: 1,200 Points"` → regex `/([\d,.]+)/` grabs first number-ish run, then `.replace(/\D/g, '')` strips separators. If MSI changes the label format or the selector, scraping silently returns null → error notification.
- **Discord**: `sendDiscordNotification(type, data)` posts an embed via `axios`. `type` is `'milestone'` or `'error'`. No-op if `DISCORD_WEBHOOK_URL` unset. A Discord post failure is logged but never throws.
- **Screenshots**: only written when `SAVE_SCREENSHOTS=true` — `latest_run.png` each run, plus `debug_error.png`/`debug_error.html` when the points element is missing (login/layout debugging).

## Config

All config is env vars read at the top of `src/index.js` (see README table). Defaults are inline there. Paths (`COOKIES_PATH`, `STATE_PATH`, `SCREENSHOT_DIR`) are overridable but default to the Docker volume layout (`./data`, `./screenshots`).

## Gotchas

- **Cookies invalidate on manual re-login**: MSI rotates `msi_members_center_session` when you log in manually in a browser. After that the bot's cookies are dead and it emits an error notification. This is expected, not a code bug.
- **`data/`, `screenshots/`, `.env` are gitignored** — including `data/cookies.json` (contains a live session token). Never commit or paste cookie contents.
- The selector and points-label format are the fragile parts; a "not logged in" error usually means dead cookies, not a selector break — check screenshots to disambiguate.

## Repository policy

The repository is permanently private. The owner authorized tracking this AGENTS.md.
The owner authorizes automatic pushes of verified changes to origin/main while GitHub confirms this repository is private. Check visibility before pushing; do not automatically push if it is public or visibility cannot be confirmed.
