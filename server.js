const express = require("express");
const cors = require("cors");
const { chromium } = require("playwright");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors({ origin: "*" }));

// Match ID to full CREX URL dictionary
const MATCH_REGISTRY = {
  "13VD": "https://crex.com/cricket-live-score/km-vs-pt-12th-match-odisha-t20-league-2026-match-updates-13VD",
  "11AI": "https://crex.com/cricket-live-score/ind-vs-wi-1st-odi-west-indies-tour-of-india-2026-match-updates-11AI",
  "VSV": "https://crex.com/cricket-live-score/eng-vs-sl-3rd-odi-sri-lanka-tour-of-england-2026-match-updates-VSV",
  "122G": "https://crex.com/cricket-live-score/ausw-a-vs-indw-a-3rd-odi-australia-a-women-tour-of-india-2026-match-updates-122G"
};

let currentMatchId = "13VD";
let currentMatchUrl = MATCH_REGISTRY["13VD"];
let isNavigating = false;

let cachedData = {
  activeMatchId: "13VD",
  team1: "KM",
  team1Logo: "",
  team2: "PT",
  team2Logo: "",
  score: "-/-",
  overs: "0.0",
  liveBall: "-",
  neededRuns: "Loading match data...",
  recentOvers: [],
  crr: "-",
  rrr: "-",
  partnership: "-",
  target: "-",
  batter1: { name: "Batter 1", score: "-", image: "" },
  batter2: { name: "Batter 2", score: "-", image: "" },
  bowler: { name: "Bowler", figures: "-", econ: "-", image: "" }
};

let browser = null;
let page = null;

async function initScraper() {
  try {
    browser = await chromium.launch({
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

    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      viewport: { width: 1280, height: 800 }
    });

    page = await context.newPage();
    await page.route("**/*.{mp4,webm,woff,woff2,ttf,css}", (r) => r.abort());

    console.log(`Connecting to initial match: ${currentMatchId}`);
    await page.goto(currentMatchUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(3000);

    scrapeActiveMatch();
    setInterval(scrapeActiveMatch, 3500);
  } catch (err) {
    console.error("Initialization error:", err.message);
    setTimeout(initScraper, 10000);
  }
}

// Dynamically resolves any CREX ID to its exact URL
async function resolveAndSwitchMatch(targetId) {
  targetId = targetId.trim().toUpperCase();
  if (isNavigating) return;
  isNavigating = true;

  console.log(`Resolving match ID: ${targetId}`);

  // 1. Instantly flush old score cache to avoid showing previous match numbers
  cachedData = {
    activeMatchId: targetId,
    team1: "...",
    team1Logo: "",
    team2: "...",
    team2Logo: "",
    score: "-/-",
    overs: "0.0",
    liveBall: "-",
    neededRuns: `Switching to ${targetId}...`,
    recentOvers: [],
    crr: "-",
    rrr: "-",
    partnership: "-",
    target: "-",
    batter1: { name: "Batter 1", score: "-", image: "" },
    batter2: { name: "Batter 2", score: "-", image: "" },
    bowler: { name: "Bowler", figures: "-", econ: "-", image: "" }
  };

  let targetUrl = MATCH_REGISTRY[targetId];

  // 2. If ID isn't in memory, search CREX live fixtures for the link ending in this ID
  if (!targetUrl && page) {
    try {
      await page.goto("https://crex.com/fixtures", { waitUntil: "domcontentloaded", timeout: 25000 });
      await page.waitForTimeout(2000);

      targetUrl = await page.evaluate((id) => {
        const anchors = Array.from(document.querySelectorAll("a[href*='cricket-live-score']"));
        const found = anchors.find((a) => {
          const u = a.href.toUpperCase();
          return u.endsWith("-" + id) || u.includes("-" + id + "?") || u.includes("-" + id + "/");
        });
        return found ? found.href : null;
      }, targetId);

      if (targetUrl) MATCH_REGISTRY[targetId] = targetUrl;
    } catch (e) {
      console.warn("Crawler fixture search warning:", e.message);
    }
  }

  // 3. Fallback direct format
  if (!targetUrl) {
    targetUrl = `https://crex.com/cricket-live-score/match-updates-${targetId}`;
    MATCH_REGISTRY[targetId] = targetUrl;
  }

  currentMatchId = targetId;
  currentMatchUrl = targetUrl;

  try {
    console.log(`Loading match URL: ${currentMatchUrl}`);
    await page.goto(currentMatchUrl, { waitUntil: "domcontentloaded", timeout: 35000 });
    await page.waitForTimeout(3000);
    await scrapeActiveMatch();
  } catch (err) {
    console.error(`Failed to load ${targetId}:`, err.message);
    cachedData.neededRuns = `Could not load match ${targetId}`;
  } finally {
    isNavigating = false;
  }
}

async function scrapeActiveMatch() {
  if (!page || isNavigating) return;

  try {
    const extracted = await page.evaluate(() => {
      const getTxt = (sel) => document.querySelector(sel)?.innerText?.trim() || "";
      const body = document.body.innerText;

      // Extract Team Names from Header or Title
      let team1 = getTxt(".team1-name, .t-name:nth-of-type(1)");
      let team2 = getTxt(".team2-name, .t-name:nth-of-type(2)");

      if (!team1 || !team2) {
        const titleMatch = document.title.match(/([A-Za-z0-9\-]+)\s+vs\s+([A-Za-z0-9\-]+)/i);
        if (titleMatch) {
          team1 = team1 || titleMatch[1];
          team2 = team2 || titleMatch[2];
        }
      }

      // Helper for player headshots & team logos
      const findImage = (name) => {
        if (!name || name.includes("Batter") || name.includes("Bowler")) return "";
        const all = Array.from(document.querySelectorAll("*")).filter(
          (el) => el.children.length === 0 && el.textContent.trim().toLowerCase() === name.toLowerCase()
        );
        for (const el of all) {
          let parent = el.parentElement;
          for (let i = 0; i < 5 && parent; i++) {
            const img = parent.querySelector("img");
            if (img) {
              const src = img.src || img.getAttribute("data-src") || "";
              if (src && !src.includes("data:image/svg") && !src.includes("icon")) return src;
            }
            parent = parent.parentElement;
          }
        }
        return "";
      };

      // Clean Score & Overs Extraction
      let score = "";
      let overs = "";
      const scoreOverRegex = /(\b\d{1,3})[-\/](10|[0-9])\s*\(?([0-5]?\d\.[0-6])\)?/g;
      const allMatches = [...body.matchAll(scoreOverRegex)];

      if (allMatches.length > 0) {
        const crrPos = body.indexOf("CRR");
        let best = allMatches[0];
        if (crrPos !== -1) {
          let minDiff = 999999;
          for (const m of allMatches) {
            const diff = Math.abs(m.index - crrPos);
            if (diff < minDiff) {
              minDiff = diff;
              best = m;
            }
          }
        } else {
          best = allMatches[allMatches.length - 1];
        }
        score = `${best[1]}/${best[2]}`;
        overs = best[3];
      }

      // Equation / Match Status
      let neededRuns = "";
      const needMatch = body.match(/([A-Za-z0-9\-]+\s+need\s+\d+\s+runs\s+in\s+\d+\s+balls)/i);
      if (needMatch) {
        neededRuns = needMatch[1].trim();
      } else {
        const statusMatch = body.match(/([A-Za-z0-9\-\s]+(?:won by|elected to|lead by|trail by|starts at|delayed)[^\n\.]+)/i);
        neededRuns = statusMatch ? statusMatch[1].trim() : "Match in Progress";
      }

      // Last Overs
      const recentOvers = [];
      const overBlocks = [...body.matchAll(/Over\s+(\d+)\s+([\s\S]*?)=\s*(\d+)/gi)];
      for (const ob of overBlocks) {
        const overNum = ob[1];
        const rawBalls = ob[2]
          .trim()
          .split(/\s+/)
          .filter((b) => b.length > 0 && !b.includes("Over") && b !== "=");
        const total = ob[3];
        recentOvers.push({ over: overNum, balls: rawBalls, total });
      }
      const lastTwoOvers = recentOvers.slice(-2);

      // Live Run
      let liveBall = "";
      if (lastTwoOvers.length > 0) {
        const latestOver = lastTwoOvers[lastTwoOvers.length - 1];
        if (latestOver.balls.length > 0) {
          liveBall = latestOver.balls[latestOver.balls.length - 1];
        }
      }
      if (!liveBall) {
        const centerBig = body.match(/\b([0-6]|4|6|W|wd|nb)\b(?=\s+CRR)/i);
        liveBall = centerBig ? centerBig[1] : "•";
      }

      // Stats
      const crrMatch = body.match(/CRR\s*[:\n]?\s*([\d\.]+)/i);
      const rrrMatch = body.match(/RRR\s*[:\n]?\s*([\d\.]+)/i);
      const partMatch = body.match(/(?:Partnership|P'ship)\s*[:\n]?\s*([0-9]+\s*\([0-9]+\))/i);

      let target = "-";
      const targetMatch = body.match(/Target\s*[:\n]?\s*(\d+)/i);
      if (targetMatch) {
        target = targetMatch[1];
      } else if (needMatch && score) {
        const runsNeed = needMatch[1].match(/need\s+(\d+)\s+runs/i);
        if (runsNeed) {
          target = String(parseInt(score.split("/")[0], 10) + parseInt(runsNeed[1], 10));
        }
      }

      // Batters
      const batterMatches = [...body.matchAll(/([A-Z][a-zA-Z\s\.]+)\s*\*?\s+(\d+)\s*\(([0-9]+)\)/g)];
      let batter1 = { name: "Batter 1", score: "-", image: "" };
      let batter2 = { name: "Batter 2", score: "-", image: "" };

      if (batterMatches.length >= 1) {
        const b1Name = batterMatches[0][1].trim().split("\n").pop();
        batter1 = {
          name: b1Name,
          score: `${batterMatches[0][2]} (${batterMatches[0][3]})`,
          image: findImage(b1Name)
        };
      }
      if (batterMatches.length >= 2) {
        const b2Name = batterMatches[1][1].trim().split("\n").pop();
        batter2 = {
          name: b2Name,
          score: `${batterMatches[1][2]} (${batterMatches[1][3]})`,
          image: findImage(b2Name)
        };
      }

      // Bowler
      const bowlerMatch = body.match(/([A-Z][a-zA-Z\s\.]+)\s+(\d+-\d+)\s*\((\d+\.?\d*)\)/);
      let bowler = { name: "Bowler", figures: "-", econ: "-", image: "" };

      if (bowlerMatch) {
        const bName = bowlerMatch[1].trim().split("\n").pop();
        const bFigs = `${bowlerMatch[2]} (${bowlerMatch[3]})`;
        let calcEcon = "-";
        const runs = parseFloat(bowlerMatch[2].split("-")[1]);
        const ovs = parseFloat(bowlerMatch[3]);
        if (!isNaN(runs) && !isNaN(ovs) && ovs > 0) {
          calcEcon = (runs / ovs).toFixed(2);
        }

        bowler = {
          name: bName,
          figures: bFigs,
          econ: calcEcon,
          image: findImage(bName)
        };
      }

      return {
        team1: team1 || "KM",
        team1Logo: findImage(team1),
        team2: team2 || "PT",
        team2Logo: findImage(team2),
        score,
        overs,
        liveBall,
        neededRuns,
        recentOvers: lastTwoOvers,
        crr: crrMatch ? crrMatch[1] : "-",
        rrr: rrrMatch ? rrrMatch[1] : "-",
        target,
        partnership: partMatch ? partMatch[1] : "-",
        batter1,
        batter2,
        bowler
      };
    });

    cachedData.activeMatchId = currentMatchId;
    if (extracted.team1) cachedData.team1 = extracted.team1;
    if (extracted.team2) cachedData.team2 = extracted.team2;
    if (extracted.team1Logo) cachedData.team1Logo = extracted.team1Logo;
    if (extracted.team2Logo) cachedData.team2Logo = extracted.team2Logo;

    if (extracted.score) cachedData.score = extracted.score;
    if (extracted.overs) cachedData.overs = extracted.overs;
    if (extracted.liveBall) cachedData.liveBall = extracted.liveBall;
    if (extracted.neededRuns) cachedData.neededRuns = extracted.neededRuns;
    if (extracted.recentOvers) cachedData.recentOvers = extracted.recentOvers;

    cachedData.crr = extracted.crr;
    cachedData.rrr = extracted.rrr;
    cachedData.target = extracted.target;
    cachedData.partnership = extracted.partnership;

    if (extracted.batter1.name !== "Batter 1") cachedData.batter1 = extracted.batter1;
    if (extracted.batter2.name !== "Batter 2") cachedData.batter2 = extracted.batter2;
    if (extracted.bowler.name !== "Bowler") cachedData.bowler = extracted.bowler;
  } catch (err) {
    console.warn("Scraping warning:", err.message);
  }
}

initScraper();

app.get("/", (req, res) => {
  res.json({ status: "online", activeMatch: currentMatchId, url: currentMatchUrl });
});

// Awaits switch before returning JSON so the frontend receives the new match right away
app.get("/api/score", async (req, res) => {
  const reqId = req.query.id;
  if (reqId && reqId.toUpperCase() !== currentMatchId) {
    await resolveAndSwitchMatch(reqId);
  }
  res.status(200).json(cachedData);
});

process.on("SIGTERM", async () => {
  if (browser) await browser.close().catch(() => {});
  process.exit(0);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Preet Sports Relay active on port ${PORT}`);
});
