const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const axios = require('axios');
const cron = require('node-cron');
require('dotenv').config();

// Configuration
const COOKIES_PATH = process.env.COOKIES_PATH || './data/cookies.json';
const STATE_PATH = process.env.STATE_PATH || './data/state.json';
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR || './screenshots';
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || '30 18 * * *';
const MILESTONES = (process.env.MILESTONES || '400,500,600').split(',').map(Number);
const TIMEZONE = process.env.TZ || 'Europe/Bratislava';
const SAVE_SCREENSHOTS = process.env.SAVE_SCREENSHOTS === 'true';
const DISCORD_USERNAME = process.env.DISCORD_USERNAME || 'MSI Rewards Daily Login Bot';


const NAVIGATION_TIMEOUT = parseInt(process.env.NAVIGATION_TIMEOUT || '60000', 10);
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '3', 10);
const RETRY_DELAY = parseInt(process.env.RETRY_DELAY || '30000', 10); // 30 seconds
const POINTS_SELECTOR = '.kv__memberbox--info li:nth-child(2)';

// Ensure directories exist
if (!fs.existsSync(path.dirname(STATE_PATH))) fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
if (SAVE_SCREENSHOTS && !fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

const log = (msg) => console.log(`[${new Date().toLocaleString('sk-SK', { timeZone: TIMEZONE })}] ${msg}`);

async function sendDiscordNotification(type, data) {
    if (!DISCORD_WEBHOOK_URL) return;

    const embed = {
        title: "MSI Reward Program",
        url: "https://rewards.msi.com/",
        timestamp: new Date().toISOString()
    };

    if (type === 'milestone') {
        embed.color = 5763719; // Green (0x57F287)
        embed.description = `🎉 **Milestone Reached!**\n\nCurrent Points: **${data.points}**\nMilestone Passed: **${data.milestone}**`;
    } else if (type === 'error') {
        embed.color = 15548997; // Red (0xED4245)
        embed.description = `❌ **Error Occurred**\n\n${data.message}`;
    }

    try {
        await axios.post(DISCORD_WEBHOOK_URL, {
            username: DISCORD_USERNAME,
            embeds: [embed]
        });
        log(`Sent Discord notification (${type})`);
    } catch (error) {
        log(`Failed to send Discord notification: ${error.message}`);
    }
}

async function runBot() {
    log('Starting bot run...');
    let browser;
    try {
        browser = await puppeteer.launch({
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium-browser',
            headless: 'new',
            args: [
                '--no-sandbox',               // Disables root sandbox requirement for unprivileged Linux Docker containers
                '--disable-setuid-sandbox',     // Disables setuid sandbox in container environments
                '--disable-dev-shm-usage',     // Uses /tmp instead of /dev/shm to avoid container shared memory allocation limits
                '--disable-gpu',               // Disables GPU hardware acceleration inside headless containers
                '--disable-crash-reporter',    // Disables Crashpad worker process to fix sched_getscheduler (ENOSYS) error in Docker seccomp
                '--disable-breakpad',         // Disables Breakpad crash monitoring service
                '--no-zygote',                // Prevents spawning zygote child processes that attempt scheduler queries
                '--disable-software-rasterizer'// Prevents fallback software rasterizer rendering crashes in headless environments
            ]
        });
        const page = await browser.newPage();
        await page.setViewport({ width: 1920, height: 1080 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        // Load Cookies
        if (fs.existsSync(COOKIES_PATH)) {
            const fileStats = fs.statSync(COOKIES_PATH);
            if (fileStats.size === 0) {
                throw new Error('cookies.json is empty. Please export cookies and save them to this file.');
            }

            try {
                const cookiesString = fs.readFileSync(COOKIES_PATH, 'utf8');
                const cookies = JSON.parse(cookiesString);
                await page.setCookie(...cookies);
                log('Cookies loaded.');
            } catch (e) {
                if (e instanceof SyntaxError) {
                    throw new Error(`Invalid JSON in cookies.json: ${e.message}`);
                }
                throw e;
            }
        } else {
            throw new Error(`cookies.json not found at ${COOKIES_PATH}`);
        }

        // Navigate
        await page.goto('https://rewards.msi.com/', {
            waitUntil: 'networkidle2',
            timeout: NAVIGATION_TIMEOUT
        });
        log('Page loaded.');

        // Scroll to top (User reported auto-scroll might hide points)
        await page.evaluate(() => window.scrollTo(0, 0));
        await new Promise(r => setTimeout(r, 1000)); // Short wait for scroll

        // Take debug screenshot (if enabled)
        if (SAVE_SCREENSHOTS) {
            await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'latest_run.png') });
        }

        // Extract points using exact selector
        // Selector found: .kv__memberbox--info li:nth-child(2)
        const pointsElementIdentifier = POINTS_SELECTOR;

        // Wait for the element to appear (timeout 5s to be safe, though networkidle2 should suffice)
        try {
            await page.waitForSelector(pointsElementIdentifier, { timeout: 10000 }); // 10s wait for element
        } catch (e) {
            log('WARNING: Points element not immediately found.');
        }

        const pointsText = await page.evaluate((selector) => {
            const el = document.querySelector(selector);
            return el ? el.textContent.trim() : null;
        }, pointsElementIdentifier);

        if (!pointsText) {
            log('ERROR: Could not find points element (.kv__memberbox--info li:nth-child(2)). User might not be logged in.');

            if (SAVE_SCREENSHOTS) {
                const html = await page.content();
                fs.writeFileSync(path.join(SCREENSHOT_DIR, 'debug_error.html'), html);
                await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'debug_error.png') });
            }
            throw new Error("Could not find points element. Check if cookies are valid or site layout changed.");
        }

        // Parse number from strings like "My Points: 1,200 Points"
        // 1. Match the first sequence of digits/commas/dots
        const match = pointsText.match(/([\d,.]+)/);

        if (!match) {
            throw new Error(`Could not parse points from text: "${pointsText}"`);
        }

        // 2. Remove non-digits from that specific sequence (to handle 1,200 -> 1200)
        const cleanPoints = match[1].replace(/\D/g, '');
        const currentPoints = parseInt(cleanPoints, 10);

        if (isNaN(currentPoints)) {
            throw new Error(`Could not parse points from text: "${pointsText}"`);
        }
        log(`Current Points: ${currentPoints}`);

        // State Management & Notifications
        let state = {};
        if (fs.existsSync(STATE_PATH)) {
            state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
        }

        const lastPoints = state.lastPoints || 0;

        // Check Milestones
        // We notify if we crossed a milestone boundary since the last run
        // i.e., lastPoints < Milestone <= currentPoints
        for (const milestone of MILESTONES) {
            if (lastPoints < milestone && currentPoints >= milestone) {
                await sendDiscordNotification('milestone', { points: currentPoints, milestone: milestone });
            }
        }

        // Update state
        state.lastPoints = currentPoints;
        state.lastRun = new Date().toISOString();
        fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));

        return { success: true };

    } catch (error) {
        log(`ERROR: ${error.message}`);
        if (browser) await browser.close(); // Safety close

        // Check for Fatal Errors (Configuration issues like missing/invalid cookies)
        const isFatal = error.message.includes('cookies.json') || error.message.includes('Invalid JSON');
        return { success: false, error: error.message, fatal: isFatal };
    } finally {
        if (browser) await browser.close();
        log('Run complete.');
    }
}

async function runWithRetry() {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        log(`Starting run (Attempt ${attempt}/${MAX_RETRIES})...`);
        const result = await runBot();

        if (result.success) {
            return { success: true };
        }

        if (result.fatal) {
            log(`FATAL error encountered: "${result.error}". Aborting retries.`);
            // Send Discord notification immediately for fatal configuration errors
            await sendDiscordNotification('error', { message: `FATAL ERROR: ${result.error}` });
            return result; // Propagate fatal error immediately
        }

        if (attempt < MAX_RETRIES) {
            log(`Run failed (Attempt ${attempt}/${MAX_RETRIES}). Retrying in ${RETRY_DELAY / 1000}s...`);
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
        } else {
            log(`All ${MAX_RETRIES} attempts failed. Last error: "${result.error}"`);
            // Only send Discord notification when ALL retries are exhausted to avoid false alarm alerts
            await sendDiscordNotification('error', { message: `All ${MAX_RETRIES} attempts failed. Last error: ${result.error}` });
            return result;
        }
    }
    return { success: false, error: 'Max retries exhausted' };
}

// Single run argument
if (process.argv.includes('--run-once')) {
    runWithRetry();
} else {
    // Cron Mode
    log(`Initializing Bot. Running initial check...`);

    // Run immediately on startup
    runWithRetry().then((result) => {
        if (result.success) {
            log(`Initial check complete. Next run scheduled for: ${CRON_SCHEDULE} (TZ: ${TIMEZONE})`);
            cron.schedule(CRON_SCHEDULE, () => {
                runWithRetry();
            }, {
                scheduled: true,
                timezone: TIMEZONE
            });
        } else {
            if (result.fatal) {
                log(`CRITICAL: Initial run failed with FATAL error: "${result.error}". Entering dormant mode to prevent restart loop. Please fix the error (e.g. cookies) and restart.`);
                // Keep process alive but do nothing
                setInterval(() => { }, 1000 * 60 * 60 * 24);
            } else {
                log(`WARNING: Initial run failed ("${result.error}"), but error is transient. Scheduling next run for ${CRON_SCHEDULE} (TZ: ${TIMEZONE})`);
                cron.schedule(CRON_SCHEDULE, () => {
                    runWithRetry();
                }, {
                    scheduled: true,
                    timezone: TIMEZONE
                });
            }
        }
    });
}
