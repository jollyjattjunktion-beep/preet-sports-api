const express = require("express");
const cors = require("cors");
const { chromium } = require("playwright");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors({ origin: "*" }));

// Dynamic URL cache: maps IDs like "13VD" to their full CREX URL
const urlCache = {
  "13VD": "https://crex.com/cricket-live-score/km-vs-pt-12th-match-odisha-t20-league-2026-match-updates-13VD",
  "11AI": "https://crex.com/cricket-live-score/ind-vs-wi-1st-odi-west-indies-tour-of-india-2026-match-updates-11AI",
  "VSV": "https://crex.com/cricket-live-score/eng-vs-sl-3rd-odi-sri-lanka-tour-of-england-2026-match-updates-VSV",
  "122G": "https://crex.com/cricket-live-score/ausw-a-vs-indw-a-3rd-odi-australia-a-women-tour-of-india-2026-match-updates-122G"
};

let currentMatchId = "13VD";
let currentMatchUrl = urlCache["13VD"];

let cachedData = {
  activeMatchId: "13VD",
  team1: "KM",
  team1Logo: "",
  team2: "PT",
  team2Logo: "",
  score: "0/0",
  overs: "0.0",
  liveBall: "-",
  neededRuns: "Loading match data...",
  recentOvers: [],
  crr: "-",
  rrr: "-",
  partnership: "-",
  target: "-",
  batter1: { name: "Batter 1", score: "0 (0)", image: "" },
  batter2: { name: "Batter 2", score: "0 (0)", image: "" },
  bowler: { name: "Bowler", figures: "0-0 (0.0)", econ: "0.00", image: "" }
};

let browserInstance = null;
let pageInstance = null;
let isSwitching = false;

// Crawls CREX fixtures to auto-discover match IDs
async function harvestMatchUrls() {
  if (!pageInstance) return;
  try {
    const foundLinks = await pageInstance.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll("a[href*='cricket-live-score']"));
      return anchors.map(a => a.href).filter(Boolean);
    });

    foundLinks.forEach(link => {
      const match = link.match(/-([a-zA-Z0-9]+)$/);
      if (match) {
        urlCache[match[1].toUpperCase()] = link;
      }
    });
  } catch (e) {
    // Non-fatal warning
  }
}

// Launches browser and stays open
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
    await pageInstance.route("**/*.{mp4,webm,woff,woff2,ttf,css}", (route) => route.abort());

    console.log(`Starting with match ID: ${currentMatchId}`);
    await pageInstance.goto(currentMatchUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await pageInstance.waitForTimeout(3000);

    scrapeData();
    setInterval(scrapeData, 3500);

    // Harvest new match links every 60 seconds
    setInterval(harvestMatchUrls, 60000);
  } catch (err) {
    console.error("Browser launch failed:", err.message);
    setTimeout(initBrowser, 10000);
  }
}

// Automatically finds and switches to any Match ID
async function switchMatch(targetId) {
  if (!targetId) return;
  targetId = targetId.trim().toUpperCase();

  if (targetId === currentMatchId && !isSwitching) return;
  isSwitching = true;
  console.log(`[SWITCH] Resolving URL for ID: ${targetId}`);

  let resolvedUrl = urlCache[targetId];

  // If ID is not in memory cache, search CREX fixtures list live
  if (!resolvedUrl && pageInstance) {
    try {
      console.log(`Searching CREX fixtures for ID: ${targetId}...`);
      await pageInstance.goto("https://crex.com/fixtures", { waitUntil: "domcontentloaded", timeout: 25000 });
      await pageInstance.waitForTimeout(2000);

      resolvedUrl = await pageInstance.evaluate((id) => {
        const anchors = Array.from(document.querySelectorAll("a[href*='cricket-live-score']"));
        const found = anchors.find(a => {
          const upper = a.href.toUpperCase();
          return upper.endsWith("-" + id) || upper.includes("-" + id + "?") || upper.includes("-" + id + "/");
        });
        return found ? found.href : null;
      }, targetId);

      if (resolvedUrl) {
        urlCache[targetId] = resolvedUrl;
      }
    } catch (e) {
      console.warn("Fixture discovery error:", e.message);
    }
  }

  // Fallback to direct match slug format if not found on fixtures list
  if (!resolvedUrl) {
    resolvedUrl = `https://crex.com/cricket-live-score/live-match-updates-${targetId}`;
    urlCache[targetId] = resolvedUrl;
  }

  currentMatchId = targetId;
  currentMatchUrl = resolvedUrl;
  cachedData.activeMatchId = targetId;
  cachedData.neededRuns = `Connecting to match ${targetId}...`;

  try {
    console.log(`Navigating to: ${currentMatchUrl}`);
    await pageInstance.goto(currentMatchUrl, { waitUntil: "domcontentloaded", timeout: 35000 });
    await pageInstance.waitForTimeout(3000);
    await scrapeData();
  } catch (err) {
    console.error(`Failed to load match ${targetId}:`, err.message);
    cachedData.neededRuns = `Match ${targetId} not live or invalid ID`;
  } finally {
    isSwitching = false;
  }
}

async function scrapeData() {
  if (!pageInstance || isSwitching) return;

  try {
    const extracted = await pageInstance.evaluate(() => {
      const getTxt = (sel) => document.querySelector(sel)?.innerText?.trim() || "";
      const body = document.body.innerText;

      const findImageNearText = (name) => {
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

      // 1. Teams & Logos
      const team1 = getTxt(".team1-name, .t-name:nth-of-type(1)") || "TEAM 1";
      const team2 = getTxt(".team2-name, .t-name:nth-of-type(2)") || "TEAM 2";
      const team1Logo = findImageNearText(team1);
      const team2Logo = findImageNearText(team2);

      // 2. Score & Overs Clean Extraction
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

      // 3. Match Situation / Target Equation
      let neededRuns = "";
      const needMatch = body.match(/([A-Za-z0-9\-]+\s+need\s+\d+\s+runs\s+in\s+\d+\s+balls)/i);
      if (needMatch) {
        neededRuns = needMatch[1].trim();
      } else {
        const statusMatch = body.match(/([A-Za-z0-9\-\s]+(?:won by|elected to|lead by|trail by)[^\n\.]+)/i);
        neededRuns = statusMatch ? statusMatch[1].trim() : "Match in Progress";
      }

      // 4. Over-by-Over Columns
      const recentOvers = [];
      const overBlocks = [...body.matchAll(/Over\s+(\d+)\s+([\s\S]*?)=\s*(\d+)/gi)];
      for (const ob of overBlocks) {
        const overNum = ob[1];
        const rawBalls = ob[2]
          .trim()
          .split(/\s+/)
          .filter((b) => b.length > 0 && !b.includes("Over") && b !== "=");
        const total = ob[3];
        recentOvers.push({ over: overNum, balls: rawBalls, total: total });
      }
      const lastTwoOvers = recentOvers.slice(-2);

      // 5. Live Ball
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

      // 6. Stats Strip
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

      // 7. Batters
      const batterMatches = [...body.matchAll(/([A-Z][a-zA-Z\s\.]+)\s*\*?\s+(\d+)\s*\(([0-9]+)\)/g)];
      let batter1 = { name: "Batter 1", score: "-", image: "" };
      let batter2 = { name: "Batter 2", score: "-", image: "" };

      if (batterMatches.length >= 1) {
        const b1Name = batterMatches[0][1].trim().split("\n").pop();
        batter1 = {
          name: b1Name,
          score: `${batterMatches[0][2]} (${batterMatches[0][3]})`,
          image: findImageNearText(b1Name)
        };
      }
      if (batterMatches.length >= 2) {
        const b2Name = batterMatches[1][1].trim().split("\n").pop();
        batter2 = {
          name: b2Name,
          score: `${batterMatches[1][2]} (${batterMatches[1][3]})`,
          image: findImageNearText(b2Name)
        };
      }

      // 8. Bowler
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
          image: findImageNearText(bName)
        };
      }

      return {
        team1,
        team1Logo,
        team2,
        team2Logo,
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

    if (extracted.score && extracted.score !== "0/0") cachedData.score = extracted.score;
    if (extracted.overs && extracted.overs !== "0.0") cachedData.overs = extracted.overs;
    if (extracted.team1 && extracted.team1 !== "TEAM 1") cachedData.team1 = extracted.team1;
    if (extracted.team2 && extracted.team2 !== "TEAM 2") cachedData.team2 = extracted.team2;
    if (extracted.team1Logo) cachedData.team1Logo = extracted.team1Logo;
    if (extracted.team2Logo) cachedData.team2Logo = extracted.team2Logo;
    if (extracted.liveBall) cachedData.liveBall = extracted.liveBall;
    if (extracted.neededRuns) cachedData.neededRuns = extracted.neededRuns;
    if (extracted.recentOvers && extracted.recentOvers.length > 0) cachedData.recentOvers = extracted.recentOvers;

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
  res.json({ status: "online", activeMatch: currentMatchId, url: currentMatchUrl, cachedIds: Object.keys(urlCache) });
});

// Dynamic endpoint: /api/score?id=13VD
app.get("/api/score", async (req, res) => {
  const reqId = req.query.id;
  if (reqId && reqId.toUpperCase() !== currentMatchId) {
    switchMatch(reqId);
  }
  res.status(200).json(cachedData);
});

process.on("SIGTERM", async () => {
  if (browserInstance) await browserInstance.close().catch(() => {});
  process.exit(0);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Preet Sports Relay active on port ${PORT}`);
});
