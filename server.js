const express = require("express");
const cors = require("cors");
const { chromium } = require("playwright");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors({
    origin: [
        "https://preetsports.cu.ma",
        "https://www.preetsports.cu.ma"
    ]
}));

// ---- Config -------------------------------------------------------------
// Point this at whichever match page you want the board to follow.
const MATCH_URL = process.env.CREX_MATCH_URL ||
  "https://crex.com/cricket-live-score/ausw-a-vs-indw-a-3rd-odi-australia-a-women-tour-of-india-2026-match-updates-122G";

// Don't re-scrape on every request — cache for a bit so you're not hammering
// their servers (kinder to them, and much faster for you).
const CACHE_TTL_MS = 15000;

// Simple shared secret so /api/debug isn't a fully open proxy to the world.
// Set DEBUG_KEY in Render's environment variables; defaults to something
// you should change.
const DEBUG_KEY = process.env.DEBUG_KEY || "change-me";

// ---- Browser singleton ---------------------------------------------------
// Launching a fresh Chromium per request is slow and memory-heavy. Launch
// once, reuse it, open a new page per scrape.
let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      // --no-sandbox is required in most containerized hosts (Render, Docker, etc.)
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });
  }
  return browserPromise;
}

async function withPage(fn) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    viewport: { width: 1280, height: 900 }
  });
  const page = await context.newPage();
  try {
    return await fn(page);
  } finally {
    await context.close();
  }
}

// ---- Scraping -------------------------------------------------------------
// PLACEHOLDER — this needs your input.
// I can't see CREX's real rendered DOM (no JS execution on my end), so this
// function currently just waits for the page to finish loading and returns
// the visible text. It does NOT yet reliably pull out runs/wickets/overs —
// see /api/debug below for how we fix that together.
async function scrapeMatch(url) {
  return withPage(async (page) => {
    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });

    // Give client-side rendering a moment to finish painting the live
    // score widget specifically (networkidle alone isn't always enough
    // on heavy SPA pages).
    await page.waitForTimeout(2000);

    const bodyText = await page.evaluate(() => document.body.innerText);
    return { bodyText };
  });
}

let cache = { data: null, fetchedAt: 0 };

async function getScoreData() {
  const now = Date.now();
  if (cache.data && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.data;
  }
  const scraped = await scrapeMatch(MATCH_URL);
  cache = { data: scraped, fetchedAt: now };
  return scraped;
}

// ---- Routes -----------------------------------------------------------

app.get("/", (req, res) => {
  res.json({ status: "online", service: "Preet Sports Live Score API" });
});

// TEMPORARY debug route. Hit this once deployed:
//   https://your-service.onrender.com/api/debug?key=YOUR_DEBUG_KEY
// Paste the "bodyText" it returns back into the chat — that's the real
// rendered page content, and from it I can write exact, working extraction
// logic instead of guessing. Remove this route once extraction is solid,
// since it exposes proxied page content to anyone with the key.
app.get("/api/debug", async (req, res) => {
  if (req.query.key !== DEBUG_KEY) {
    return res.status(403).json({ status: "error", message: "Bad or missing key." });
  }
  try {
    const scraped = await scrapeMatch(MATCH_URL);
    res.json({ status: "ok", ...scraped });
  } catch (err) {
    console.error("Debug scrape failed:", err);
    res.status(502).json({ status: "error", message: err.message });
  }
});

app.get("/api/score", async (req, res) => {
  try {
    const scraped = await getScoreData();

    // Until real selectors are wired in, this still returns your original
    // static placeholder numbers so the frontend keeps rendering — it just
    // also attaches the raw scraped text so you can see what's available.
    res.json({
      status: "online",

      teams: {
        batting: { name: "TEAM A", logo: "" },
        bowling: { name: "TEAM B", logo: "" }
      },

      score: { runs: 151, wickets: 3, overs: "18.4" },
      currentRunRate: "8.09",
      required: { rrr: "9.25" },
      partnership: "42 (28)",
      target: "187",

      batters: [
        { name: "Batter One", runs: 68, balls: 42, fours: 6, sixes: 3, strikeRate: "161.90", image: "" },
        { name: "Batter Two", runs: 31, balls: 24, fours: 3, sixes: 1, strikeRate: "129.17", image: "" }
      ],

      bowler: { name: "Bowler One", wickets: 1, runs: 28, overs: "3.4", economy: "7.63", image: "" },

      _debug_note: "Static placeholder data — see /api/debug to help wire up real extraction."
    });
  } catch (err) {
    console.error("Score fetch failed:", err);
    res.status(502).json({ status: "error", message: err.message });
  }
});

// ---- Shutdown -------------------------------------------------------------
process.on("SIGTERM", async () => {
  if (browserPromise) {
    const browser = await browserPromise;
    await browser.close().catch(() => {});
  }
  process.exit(0);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Preet Sports API running on port ${PORT}`);
});
