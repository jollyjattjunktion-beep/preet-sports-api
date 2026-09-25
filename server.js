const express = require("express");
const cors = require("cors");
const { chromium } = require("playwright");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors({ origin: "*" }));

const MATCH_URL =
  process.env.CREX_MATCH_URL ||
  "https://crex.com/cricket-live-score/ausw-a-vs-indw-a-3rd-odi-australia-a-women-tour-of-india-2026-match-updates-122G";

let cachedScore = {
  team1: "INDW-A",
  team2: "AUSW-A",
  score: "172/4",
  overs: "27.0",
  crr: "6.37",
  rrr: "-",
  partnership: "-",
  target: "-",
  batter1: { name: "Batter 1", score: "0 (0)" },
  batter2: { name: "Batter 2", score: "0 (0)" },
  bowler: { name: "Bowler", figures: "0-0 (0.0)", econ: "0.00" }
};

let browser = null;
let page = null;

async function setupScraper() {
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--single-process"
      ]
    });

    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    });

    page = await context.newPage();
    // Block heavy assets
    await page.route("**/*.{png,jpg,jpeg,webp,svg,gif,woff,woff2,ttf}", (route) => route.abort());

    console.log("Navigating to CREX match...");
    await page.goto(MATCH_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(3000);

    // Continuous scrape every 5 seconds
    setInterval(extractLiveData, 5000);
  } catch (err) {
    console.error("Initialization error:", err.message);
  }
}

async function extractLiveData() {
  if (!page) return;
  try {
    const rawData = await page.evaluate(() => {
      const fullText = document.body.innerText;

      // Extract raw elements or fallback to text regex
      const getTxt = (sel) => document.querySelector(sel)?.innerText?.trim() || "";

      return {
        bodyText: fullText,
        scoreRaw: getTxt(".live-score, .team-score, .total-score"),
        team1Raw: getTxt(".team1-name, .team-name"),
        team2Raw: getTxt(".team2-name")
      };
    });

    const text = rawData.bodyText;

    // 1. Extract Score and Overs cleanly using Regex
    // Matches patterns like "172/4 (27.0)" or "172-4" and "27.0"
    const scoreMatch = text.match(/(\d{1,3}[\/-]\d{1,2})\s*\(?(\d{1,2}\.\d)?\)?/);
    if (scoreMatch) {
      cachedScore.score = scoreMatch[1].replace("-", "/");
      if (scoreMatch[2]) cachedScore.overs = scoreMatch[2];
    } else {
      const numMatch = text.match(/(\d{1,3}[\/-]\d{1,2})/);
      if (numMatch) cachedScore.score = numMatch[1].replace("-", "/");
      const overMatch = text.match(/(\d{1,2}\.\d)\s*(ov|overs|Overs)/i);
      if (overMatch) cachedScore.overs = overMatch[1];
    }

    // 2. CRR & RRR
    const crrMatch = text.match(/CRR\s*[:\n]?\s*([\d\.]+)/i);
    if (crrMatch) cachedScore.crr = crrMatch[1];

    const rrrMatch = text.match(/RRR\s*[:\n]?\s*([\d\.]+)/i);
    if (rrrMatch) cachedScore.rrr = rrrMatch[1];

    // 3. Target & Partnership
    const targetMatch = text.match(/Target\s*[:\n]?\s*(\d+)/i);
    if (targetMatch) cachedScore.target = targetMatch[1];

    const partMatch = text.match(/(?:Partnership|P'ship)\s*[:\n]?\s*([\d\(\)\s]+)/i);
    if (partMatch) cachedScore.partnership = partMatch[1].trim();

    // 4. Batters (Extract names + runs (balls))
    const batterMatches = [...text.matchAll(/([A-Z][a-zA-Z\s\.]+)\s*\*?\s+(\d+)\s*\(([0-9]+)\)/g)];
    if (batterMatches.length >= 1) {
      cachedScore.batter1 = {
        name: batterMatches[0][1].trim().split("\n").pop(),
        score: `${batterMatches[0][2]} (${batterMatches[0][3]})`
      };
    }
    if (batterMatches.length >= 2) {
      cachedScore.batter2 = {
        name: batterMatches[1][1].trim().split("\n").pop(),
        score: `${batterMatches[1][2]} (${batterMatches[1][3]})`
      };
    }

    // 5. Bowler (Figures & Economy)
    const bowlerMatch = text.match(/([A-Z][a-zA-Z\s\.]+)\s+(\d+-\d+)\s*\((\d+\.?\d*)\)\s+([\d\.]+)/);
    if (bowlerMatch) {
      cachedScore.bowler = {
        name: bowlerMatch[1].trim().split("\n").pop(),
        figures: `${bowlerMatch[2]} (${bowlerMatch[3]})`,
        econ: bowlerMatch[4]
      };
    }
  } catch (err) {
    console.warn("Background scrape warning:", err.message);
  }
}

setupScraper();

// API endpoint returning cleanly parsed data instantly
app.get("/api/score", (req, res) => {
  res.status(200).json(cachedScore);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Preet Sports API running on port ${PORT}`);
});
