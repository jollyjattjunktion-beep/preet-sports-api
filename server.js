const express = require("express");
const cors = require("cors");
const { chromium } = require("playwright");

const app = express();
const PORT = process.env.PORT || 10000;

// Allow requests from your website or any origin
app.use(cors({ origin: "*" }));

// ---- Config -------------------------------------------------------------
const MATCH_URL =
  process.env.CREX_MATCH_URL ||
  "https://crex.com/cricket-live-score/ausw-a-vs-indw-a-3rd-odi-australia-a-women-tour-of-india-2026-match-updates-122G";

const CACHE_TTL_MS = 10000; // Cache for 10 seconds to stay responsive

// ---- Browser Singleton --------------------------------------------------
let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });
  }
  return browserPromise;
}

async function withPage(fn) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    viewport: { width: 1280, height: 900 }
  });
  const page = await context.newPage();
  try {
    return await fn(page);
  } finally {
    await context.close();
  }
}

// ---- Live Scrape Function -----------------------------------------------
async function scrapeMatch(url) {
  return withPage(async (page) => {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 35000 });

    // Wait a brief moment for dynamic client-side hydration
    await page.waitForTimeout(3000);

    const matchData = await page.evaluate(() => {
      const getTxt = (sel) => document.querySelector(sel)?.innerText?.trim() || "";

      // Match info & Scores
      // CREX standard selector paths
      const team1 = getTxt(".team-name, .t-name, .team1-name") || "TEAM 1";
      const team2 = getTxt(".team2-name, .team-name-sec") || "TEAM 2";
      const scoreStr = getTxt(".team-score, .live-score, .score") || "0/0";
      const oversStr = getTxt(".overs, .overs-info") || "0.0";
      
      const crr = getTxt(".crr, .current-rr") || "-";
      const rrr = getTxt(".rrr, .req-rr") || "-";
      const partnership = getTxt(".partnership, .part-info") || "-";
      const target = getTxt(".target, .target-score") || "-";

      // Batters
      const batterRows = Array.from(document.querySelectorAll(".batsman-table tbody tr, .live-batsman tr, .batter-card"));
      let batter1 = { name: "Batter 1", score: "0 (0)" };
      let batter2 = { name: "Batter 2", score: "0 (0)" };

      if (batterRows.length > 0) {
        const row1 = batterRows[0].innerText.split("\t").map((s) => s.trim()).filter(Boolean);
        batter1 = {
          name: row1[0] || "Batter 1",
          score: `${row1[1] || 0} (${row1[2] || 0})`
        };
      }
      if (batterRows.length > 1) {
        const row2 = batterRows[1].innerText.split("\t").map((s) => s.trim()).filter(Boolean);
        batter2 = {
          name: row2[0] || "Batter 2",
          score: `${row2[1] || 0} (${row2[2] || 0})`
        };
      }

      // Bowler
      const bowlerRow = document.querySelector(".bowler-table tbody tr, .live-bowler tr");
      let bowler = { name: "Bowler", figures: "0-0 (0.0)", econ: "0.00" };
      if (bowlerRow) {
        const cols = bowlerRow.innerText.split("\t").map((s) => s.trim()).filter(Boolean);
        bowler = {
          name: cols[0] || "Bowler",
          figures: `${cols[3] || 0}-${cols[2] || 0} (${cols[1] || 0.0})`,
          econ: cols[4] || "0.00"
        };
      }

      return {
        team1,
        team2,
        score: scoreStr,
        overs: oversStr,
        crr,
        rrr,
        partnership,
        target,
        batter1,
        batter2,
        bowler
      };
    });

    return matchData;
  });
}

// ---- Cache Manager ------------------------------------------------------
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

// ---- Routes -------------------------------------------------------------
app.get("/", (req, res) => {
  res.json({ status: "online", service: "Preet Sports Live Score API" });
});

app.get("/api/score", async (req, res) => {
  try {
    const data = await getScoreData();
    res.json(data);
  } catch (err) {
    console.error("Score fetch failed:", err);
    res.status(502).json({ error: "Failed to scrape match data", details: err.message });
  }
});

// Clean browser process on service restart
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
