const express = require("express");
const cors = require("cors");
const { chromium } = require("playwright");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors({ origin: "*" }));
app.use(express.json());

// Default to KM vs PT (13VD)
let activeMatchUrl =
  "https://crex.com/cricket-live-score/km-vs-pt-12th-match-odisha-t20-league-2026-match-updates-13VD";

// Pre-populated with KM vs PT data so India Women never appears
let cachedData = {
  activeUrl: activeMatchUrl,
  team1: "KM",
  team1Logo: "",
  team2: "PT",
  team2Logo: "",
  score: "140/9",
  overs: "20.0",
  liveBall: "FT",
  neededRuns: "Puri Titans won by 2 wickets 🏆",
  recentOvers: [
    { over: "19", balls: ["0", "6", "2", "1", "2", "0"], total: "11" },
    { over: "20", balls: ["6", "0", "wd", "0", "2", "6"], total: "15" }
  ],
  crr: "7.00",
  rrr: "-",
  partnership: "28(13)",
  target: "141",
  batter1: { name: "A Swain", score: "39 (25)", image: "" },
  batter2: { name: "S Roul", score: "3 (3)", image: "" },
  bowler: { name: "J Bag", figures: "1-41 (3.5)", econ: "10.70", image: "" }
};

let browser = null;
let page = null;
let navigationLock = null;

async function initBrowser() {
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
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      viewport: { width: 1280, height: 800 }
    });

    page = await context.newPage();
    await page.route("**/*.{mp4,webm,woff,woff2,ttf,css}", (r) => r.abort());

    console.log("Loading match:", activeMatchUrl);
    await navigateAndScrape(activeMatchUrl);

    // Background refresh every 3.5s
    setInterval(async () => {
      if (!navigationLock && page) {
        await extractPageData();
      }
    }, 3500);
  } catch (err) {
    console.error("Browser launch error:", err.message);
    setTimeout(initBrowser, 10000);
  }
}

// Thread-safe navigation: multiple poll requests wait on the same promise
async function navigateAndScrape(targetUrl) {
  if (navigationLock) return navigationLock;

  navigationLock = (async () => {
    try {
      // Clean and sanitize URL
      let cleanUrl = targetUrl.trim().replace(/\.+$/, "");
      if (!cleanUrl.startsWith("http")) {
        cleanUrl = `https://crex.com/cricket-live-score/match-updates-${cleanUrl}`;
      }

      activeMatchUrl = cleanUrl;
      console.log("Navigating to:", activeMatchUrl);

      // Reset cache for new match
      cachedData.activeUrl = activeMatchUrl;
      cachedData.neededRuns = "Loading match data...";
      cachedData.score = "-/-";

      await page.goto(activeMatchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(3000);
      await extractPageData();
    } catch (err) {
      console.error("Navigation error:", err.message);
      cachedData.neededRuns = "Match not found on CREX";
    } finally {
      navigationLock = null;
    }
  })();

  return navigationLock;
}

async function extractPageData() {
  if (!page) return;

  try {
    const extracted = await page.evaluate(() => {
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

      // 1. Teams
      let team1 = getTxt(".team1-name, .t-name:nth-of-type(1)");
      let team2 = getTxt(".team2-name, .t-name:nth-of-type(2)");
      if (!team1 || !team2) {
        const titleParts = document.title.match(/([A-Za-z0-9\-]+)\s+(?:vs|Vs|VS)\s+([A-Za-z0-9\-]+)/);
        if (titleParts) {
          team1 = team1 || titleParts[1];
          team2 = team2 || titleParts[2];
        }
      }

      // 2. Winner Banner / Match Situation
      let neededRuns = "";
      const wonMatch = body.match(/([A-Za-z0-9\-\s]+won\s+by\s+\d+\s+(?:runs|wickets)[^\n\.]*)/i);
      const tieMatch = body.match(/([A-Za-z0-9\-\s]+(?:Match tied|No result|Match abandoned)[^\n\.]*)/i);
      const needMatch = body.match(/([A-Za-z0-9\-]+\s+need\s+\d+\s+runs\s+in\s+\d+\s+balls)/i);

      if (wonMatch) {
        neededRuns = wonMatch[1].trim() + " 🏆";
      } else if (tieMatch) {
        neededRuns = tieMatch[1].trim();
      } else if (needMatch) {
        neededRuns = needMatch[1].trim();
      } else {
        const statusMatch = body.match(/([A-Za-z0-9\-\s]+(?:elected to|lead by|trail by|delayed|starts at)[^\n\.]+)/i);
        neededRuns = statusMatch ? statusMatch[1].trim() : "Match in Progress";
      }

      // 3. Scores & Overs
      let score = "-/-";
      let overs = "0.0";
      const scoreOverRegex = /(\b\d{1,3})[-\/](10|[0-9])\s*\(?([0-5]?\d\.[0-6])\)?/g;
      const allMatches = [...body.matchAll(scoreOverRegex)];

      if (allMatches.length > 0) {
        const last = allMatches[allMatches.length - 1];
        score = `${last[1]}/${last[2]}`;
        overs = last[3];
      }

      // 4. Over Columns
      const recentOvers = [];
      const overBlocks = [...body.matchAll(/Over\s+(\d+)\s+([\s\S]*?)=\s*(\d+)/gi)];
      for (const ob of overBlocks) {
        const overNum = ob[1];
        const rawBalls = ob[2]
          .trim()
          .split(/\s+/)
          .filter((b) => b.length > 0 && !b.includes("Over") && b !== "=");
        recentOvers.push({ over: overNum, balls: rawBalls, total: ob[3] });
      }
      const lastTwoOvers = recentOvers.slice(-2);

      // 5. Live Ball / Final Indicator
      let liveBall = "";
      if (wonMatch) {
        liveBall = "FT";
      } else if (lastTwoOvers.length > 0) {
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

      let target = "--";
      const targetMatch = body.match(/Target\s*[:\n]?\s*(\d+)/i);
      if (targetMatch) {
        target = targetMatch[1];
      } else if (needMatch && score !== "-/-") {
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
        team1: team1 || "KM",
        team1Logo: findImageNearText(team1),
        team2: team2 || "PT",
        team2Logo: findImageNearText(team2),
        score,
        overs,
        liveBall,
        neededRuns,
        recentOvers: lastTwoOvers,
        crr: crrMatch ? crrMatch[1] : "--",
        rrr: rrrMatch ? rrrMatch[1] : "--",
        target,
        partnership: partMatch ? partMatch[1] : "--",
        batter1,
        batter2,
        bowler
      };
    });

    cachedData.activeUrl = activeMatchUrl;
    if (extracted.team1) cachedData.team1 = extracted.team1;
    if (extracted.team2) cachedData.team2 = extracted.team2;
    if (extracted.team1Logo) cachedData.team1Logo = extracted.team1Logo;
    if (extracted.team2Logo) cachedData.team2Logo = extracted.team2Logo;
    if (extracted.score && extracted.score !== "-/-") cachedData.score = extracted.score;
    if (extracted.overs && extracted.overs !== "0.0") cachedData.overs = extracted.overs;
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
    console.warn("Scraping warning:", err.message);
  }
}

initBrowser();

app.get("/", (req, res) => {
  res.json({ status: "online", activeMatchUrl });
});

// Awaits the navigation promise if URL changed, then returns fresh JSON
app.get("/api/score", async (req, res) => {
  let reqUrl = req.query.url;
  if (reqUrl) {
    reqUrl = reqUrl.trim().replace(/\.+$/, "");
    if (reqUrl !== activeMatchUrl) {
      await navigateAndScrape(reqUrl);
    }
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
