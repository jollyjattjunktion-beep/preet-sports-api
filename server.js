const express = require("express");
const cors = require("cors");
const { chromium } = require("playwright");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors({ origin: "*" }));

const MATCH_URL =
  process.env.CREX_MATCH_URL ||
  "https://crex.com/cricket-live-score/ausw-a-vs-indw-a-3rd-odi-australia-a-women-tour-of-india-2026-match-updates-122G";

let cachedData = {
  team1: "INDW-A",
  team2: "AUSW-A",
  score: "218/5",
  overs: "31.5",
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

    // Abort media to save container memory
    await pageInstance.route("**/*.{png,jpg,jpeg,webp,svg,gif,woff,woff2,ttf,css}", (route) => {
      route.abort();
    });

    console.log("Navigating to CREX match...");
    await pageInstance.goto(MATCH_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
    await pageInstance.waitForTimeout(3000);

    scrapeData();
    setInterval(scrapeData, 5000);
  } catch (err) {
    console.error("Browser launch error:", err.message);
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

      // 2. CRR & Stats Index
      const crrMatch = body.match(/CRR\s*[:\n]?\s*([\d\.]+)/i);
      const rrrMatch = body.match(/RRR\s*[:\n]?\s*([\d\.]+)/i);
      const targetMatch = body.match(/Target\s*[:\n]?\s*(\d+)/i);
      const partMatch = body.match(/(?:Partnership|P'ship)\s*[:\n]?\s*([0-9]+\s*\([0-9]+\))/i);

      // 3. TARGET THE EXACT MATCH SCORE & OVERS
      // We look for patterns like "218-5    31.5" or "218/5 (31.5)"
      let score = "";
      let overs = "";

      // Method A: Check dedicated score elements first
      const scoreElems = document.querySelectorAll(".team-score, .live-score, .score-info, [class*='score-card']");
      for (const el of scoreElems) {
        const txt = el.innerText.trim();
        const m = txt.match(/(\d{1,3}[-\/]\d{1,2})\s*\(?(\d{1,2}\.[0-6])\)?/);
        if (m) {
          score = m[1].replace("-", "/");
          overs = m[2];
          break;
        }
      }

      // Method B: Proximity search to CRR (Bypasses the top ticker carousel)
      if (!score || !overs) {
        const allMatches = [...body.matchAll(/(\b\d{1,3}[-\/]\d{1,2}\b)\s*\(?(\d{1,2}\.[0-6])\)?/g)];
        const crrPos = body.indexOf("CRR");

        if (allMatches.length > 0) {
          if (crrPos !== -1) {
            // Pick the match closest in text position to CRR (which belongs to this match)
            let best = allMatches[0];
            let minDiff = 999999;
            for (const item of allMatches) {
              const diff = Math.abs(item.index - crrPos);
              if (diff < minDiff) {
                minDiff = diff;
                best = item;
              }
            }
            score = best[1].replace("-", "/");
            overs = best[2];
          } else {
            // Otherwise pick the last match on page (main match is below top ticker)
            const last = allMatches[allMatches.length - 1];
            score = last[1].replace("-", "/");
            overs = last[2];
          }
        }
      }

      // 4. Batters
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

      // 5. Bowler (Clean Figures & Accurate Economy)
      const bowlerMatch = body.match(/([A-Z][a-zA-Z\s\.]+)\s+(\d+-\d+)\s*\((\d+\.?\d*)\)/);
      let bowler = { name: "Bowler", figures: "-", econ: "-" };

      if (bowlerMatch) {
        const bName = bowlerMatch[1].trim().split("\n").pop();
        const bFigs = `${bowlerMatch[2]} (${bowlerMatch[3]})`;

        // Calculate accurate economy mathematically: Conceded Runs / Overs
        let calcEcon = "-";
        const runs = parseFloat(bowlerMatch[2].split("-")[1]);
        const ovs = parseFloat(bowlerMatch[3]);
        if (!isNaN(runs) && !isNaN(ovs) && ovs > 0) {
          calcEcon = (runs / ovs).toFixed(2);
        }

        bowler = {
          name: bName,
          figures: bFigs,
          econ: calcEcon
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

    // Save extracted state
    if (extracted.score && extracted.score !== "0/0" && extracted.score !== "0/40") {
      cachedData.score = extracted.score;
    }
    if (extracted.overs && extracted.overs !== "0.0") {
      cachedData.overs = extracted.overs;
    }
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

initBrowser();

app.get("/", (req, res) => {
  res.json({ status: "online", match: MATCH_URL });
});

app.get("/api/score", (req, res) => {
  res.status(200).json(cachedData);
});

process.on("SIGTERM", async () => {
  if (browserInstance) await browserInstance.close().catch(() => {});
  process.exit(0);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Preet Sports Relay running on port ${PORT}`);
});
