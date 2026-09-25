const express = require("express");
const cors = require("cors");
const { chromium } = require("playwright");

const app = express();
const PORT = process.env.PORT || 10000;

// Enable CORS for GoogieHost domain & test environments
app.use(cors({ origin: "*" }));

const MATCH_URL =
  process.env.CREX_MATCH_URL ||
  "https://crex.com/cricket-live-score/ausw-a-vs-indw-a-3rd-odi-australia-a-women-tour-of-india-2026-match-updates-122G";

// Default state so the API always responds cleanly
let cachedData = {
  team1: "INDW-A",
  team2: "AUSW-A",
  score: "0/0",
  overs: "0.0",
  crr: "-",
  rrr: "-",
  partnership: "-",
  target: "-",
  batter1: { name: "Batter 1", score: "0 (0)" },
  batter2: { name: "Batter 2", score: "0 (0)" },
  bowler: { name: "Bowler", figures: "0-0 (0.0)", econ: "0.00" }
};

let browserInstance = null;
let pageInstance = null;

// Launch optimized Chromium instance for 512MB RAM containers
async function initBrowser() {
  try {
    browserInstance = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-zygote",
        "--single-process"
      ]
    });

    const context = await browserInstance.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      viewport: { width: 1280, height: 800 }
    });

    pageInstance = await context.newPage();

    // Abort images, fonts, and stylesheets to save memory and CPU
    await pageInstance.route("**/*.{png,jpg,jpeg,webp,svg,gif,woff,woff2,ttf,css}", (route) => {
      route.abort();
    });

    console.log("Navigating to CREX match URL...");
    await pageInstance.goto(MATCH_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
    await pageInstance.waitForTimeout(3000);

    // Initial scrape & regular background loop every 5 seconds
    scrapeData();
    setInterval(scrapeData, 5000);
  } catch (err) {
    console.error("Browser launch error:", err.message);
    // Retry launch after 10 seconds if initial connection failed
    setTimeout(initBrowser, 10000);
  }
}

async function scrapeData() {
  if (!pageInstance) return;

  try {
    const extracted = await pageInstance.evaluate(() => {
      const getTxt = (sel) => document.querySelector(sel)?.innerText?.trim() || "";
      const body = document.body.innerText;

      // 1. Teams
      const team1 = getTxt(".team1-name, .t-name:nth-of-type(1)") || "INDW-A";
      const team2 = getTxt(".team2-name, .t-name:nth-of-type(2)") || "AUSW-A";

      // 2. Score & Overs (Isolated to avoid ball-by-ball commentary text)
      let score = "";
      let overs = "";

      // Regex matches patterns like "172/4" or "172-4"
      const scoreMatch = body.match(/(\b\d{1,3}[\/-]\d{1,2}\b)/);
      if (scoreMatch) {
        score = scoreMatch[1].replace("-", "/");
      }

      // Regex matches isolated overs like "27.0 ov", "27.0 overs", or "(27.0)"
      const oversMatch = body.match(/(?:\(\vert{}\b)(\d{1,2}\.\d)(?:\s*(?:ov\vert{}overs\vert{}Overs\vert{}\)))/i);
      if (oversMatch) {
        overs = oversMatch[1];
      }

      // 3. Stats Strip: CRR, RRR, Target, Partnership
      const crrMatch = body.match(/CRR\s*[:\n]?\s*([\d\.]+)/i);
      const rrrMatch = body.match(/RRR\s*[:\n]?\s*([\d\.]+)/i);
      const targetMatch = body.match(/Target\s*[:\n]?\s*(\d+)/i);
      const partMatch = body.match(/(?:Partnership|P'ship)\s*[:\n]?\s*([0-9]+\s*\([0-9]+\))/i);

      // 4. Batters (Extract Name + Runs (Balls))
      const batterMatches = [...body.matchAll(/([A-Z][a-zA-Z\s\.]+)\s*\*?\s+(\d+)\s*\(([0-9]+)\)/g)];
      let batter1 = { name: "Batter 1", score: "-" };
      let batter2 = { name: "Batter 2", score: "-" };

      if (batterMatches.length >= 1) {
        batter1 = {
          name: batterMatches[0][1].trim().split("\n").pop(),
          score: `${batterMatches[0][2]} (${batterMatches[0][3]})`
        };
      }
      if (batterMatches.length >= 2) {
        batter2 = {
          name: batterMatches[1][1].trim().split("\n").pop(),
          score: `${batterMatches[1][2]} (${batterMatches[1][3]})`
        };
      }

      // 5. Bowler (Name, Wickets-Runs (Overs), Economy)
      const bowlerMatch = body.match(/([A-Z][a-zA-Z\s\.]+)\s+(\d+-\d+)\s*\((\d+\.?\d*)\)\s+([\d\.]+)/);
      let bowler = { name: "Bowler", figures: "-", econ: "-" };

      if (bowlerMatch) {
        bowler = {
          name: bowlerMatch[1].trim().split("\n").pop(),
          figures: `${bowlerMatch[2]} (${bowlerMatch[3]})`,
          econ: bowlerMatch[4]
        };
      }

      return {
        team1,
        team2,
        score,
        overs,
        crr: crrMatch ? crrMatch[1] : "-",
        rrr: rrrMatch ? rrrMatch[1] : "-",
        target: targetMatch ? targetMatch[1] : "-",
        partnership: partMatch ? partMatch[1] : "-",
        batter1,
        batter2,
        bowler
      };
    });

    // Update cache only if valid data was found
    if (extracted.score) cachedData.score = extracted.score;
    if (extracted.overs) cachedData.overs = extracted.overs;
    if (extracted.team1) cachedData.team1 = extracted.team1;
    if (extracted.team2) cachedData.team2 = extracted.team2;

    cachedData.crr = extracted.crr;
    cachedData.rrr = extracted.rrr;
    cachedData.target = extracted.target;
    cachedData.partnership = extracted.partnership;

    if (extracted.batter1.name !== "Batter 1") cachedData.batter1 = extracted.batter1;
    if (extracted.batter2.name !== "Batter 2") cachedData.batter2 = extracted.batter2;
    if (extracted.bowler.name !== "Bowler") cachedData.bowler = extracted.bowler;
  } catch (err) {
    console.warn("Scraping tick warning:", err.message);
  }
}

// Start browser process
initBrowser();

// Health check endpoint
app.get("/", (req, res) => {
  res.json({ status: "online", match: MATCH_URL });
});

// Primary scoreboard endpoint (always returns HTTP 200 with memory cache)
app.get("/api/score", (req, res) => {
  res.status(200).json(cachedData);
});

// Graceful container shutdown
process.on("SIGTERM", async () => {
  if (browserInstance) {
    await browserInstance.close().catch(() => {});
  }
  process.exit(0);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Preet Sports Relay running on port ${PORT}`);
});
