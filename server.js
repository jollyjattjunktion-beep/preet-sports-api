const express = require("express");
const cors = require("cors");
const { chromium } = require("playwright");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors({ origin: "*" }));

// Match Registry with pre-mapped slugs
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
  status: "Connecting...",
  team1: "KM",
  team1Logo: "",
  team2: "PT",
  team2Logo: "",
  score: "0/0",
  overs: "0.0",
  liveBall: "•",
  neededRuns: "Connecting to match 13VD...",
  recentOvers: [],
  crr: "-",
  rrr: "-",
  partnership: "-",
  target: "-",
  batter1: { name: "Batter 1", score: "0 (0)", image: "" },
  batter2: { name: "Batter 2", score: "0 (0)", image: "" },
  bowler: { name: "Bowler", figures: "0-0 (0.0)", econ: "0.00", image: "" }
};

let browser = null;
let page = null;

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
    // Block video/fonts to preserve 512MB RAM limit
    await page.route("**/*.{mp4,webm,woff,woff2,ttf,css}", (r) => r.abort());

    console.log(`Connecting to initial match: ${currentMatchId}`);
    await page.goto(currentMatchUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(3000);

    scrapeActiveMatch();
    setInterval(scrapeActiveMatch, 3500);
  } catch (err) {
    console.error("Browser launch error:", err.message);
    setTimeout(initBrowser, 10000);
  }
}

async function resolveAndSwitchMatch(targetInput) {
  if (!targetInput || isNavigating) return;
  isNavigating = true;

  let targetId = targetInput.trim();
  let targetUrl = "";

  // Check if user passed full URL or just the ID
  if (targetId.startsWith("http://") || targetId.startsWith("https://")) {
    targetUrl = targetId;
    const idMatch = targetUrl.match(/-([a-zA-Z0-9]+)$/);
    targetId = idMatch ? idMatch[1].toUpperCase() : "LIVE";
    MATCH_REGISTRY[targetId] = targetUrl;
  } else {
    targetId = targetId.toUpperCase();
    targetUrl = MATCH_REGISTRY[targetId];
  }

  // Auto-find URL on CREX fixtures if not registered
  if (!targetUrl && page) {
    try {
      console.log(`Searching CREX fixtures for ID: ${targetId}...`);
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
      console.warn("Fixture lookup warning:", e.message);
    }
  }

  // Direct fallback
  if (!targetUrl) {
    targetUrl = `https://crex.com/cricket-live-score/match-updates-${targetId}`;
    MATCH_REGISTRY[targetId] = targetUrl;
  }

  currentMatchId = targetId;
  currentMatchUrl = targetUrl;
  cachedData.activeMatchId = targetId;
  cachedData.neededRuns = `Loading match ${targetId}...`;

  try {
    console.log(`Navigating to: ${currentMatchUrl}`);
    await page.goto(currentMatchUrl, { waitUntil: "domcontentloaded", timeout: 35000 });
    await page.waitForTimeout(3000);
    await scrapeActiveMatch();
  } catch (err) {
    console.error(`Failed to load ${targetId}:`, err.message);
    cachedData.neededRuns = `Could not load ${targetId}`;
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

      // 1. Teams (multi-selector fallback)
      let t1 = getTxt(".team1-name, .t-name:nth-of-type(1), .match-header .team:nth-child(1)");
      let t2 = getTxt(".team2-name, .t-name:nth-of-type(2), .match-header .team:nth-child(2)");

      if (!t1 || !t2) {
        const titleMatch = document.title.match(/([A-Za-z0-9\-]+)\s+vs\s+([A-Za-z0-9\-]+)/i);
        if (titleMatch) {
          t1 = t1 || titleMatch[1];
          t2 = t2 || titleMatch[2];
        }
      }

      // Helper for photos & flags
      const findImage = (name) => {
        if (!name || name.includes("Batter") || name.includes("Bowler")) return "";
        const all = Array.from(document.querySelectorAll("*")).filter(
          (el) => el.children.length === 0 && el.textContent.trim().toLowerCase() === name.toLowerCase()
        );
        for (const el of all) {
          let p = el.parentElement;
          for (let i = 0; i < 5 && p; i++) {
            const img = p.querySelector("img");
            if (img) {
              const src = img.src || img.getAttribute("data-src") || "";
              if (src && !src.includes("data:image/svg") && !src.includes("icon")) return src;
            }
            p = p.parentElement;
          }
        }
        return "";
      };

      // 2. Score & Overs (Handles Live, Break, & Finished matches)
      let score = "";
      let overs = "";

      const scoreMatches = [...body.matchAll(/(\b\d{1,3})[-\/](10|[0-9])\s*\(?([0-5]?\d\.[0-6])\)?/g)];
      if (scoreMatches.length > 0) {
        const last = scoreMatches[scoreMatches.length - 1];
        score = `${last[1]}/${last[2]}`;
        overs = last[3];
      } else {
        // Fallback for matches formatted as "145/6 (20.0)"
        const singleScore = body.match(/(\d{1,3}[\/-]\d{1,2})\s*\((\d{1,2}\.\d)\)/);
        if (singleScore) {
          score = singleScore[1].replace("-", "/");
          overs = singleScore[2];
        }
      }

      // 3. Match Situation / Result
      let neededRuns = "";
      const needMatch = body.match(/([A-Za-z0-9\-]+\s+need\s+\d+\s+runs\s+in\s+\d+\s+balls)/i);
      const resultMatch = body.match(/([A-Za-z0-9\-\s]+(?:won by|elected to|lead by|trail by|won the match)[^\n\.]+)/i);

      if (needMatch) {
        neededRuns = needMatch[1].trim();
      } else if (resultMatch) {
        neededRuns = resultMatch[1].trim();
      } else {
        neededRuns = "Match in Progress";
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
        recentOvers.push({ over: overNum, balls: rawBalls, total });
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
      let batter1 = { name: "Batter 1", score: "0 (0)", image: "" };
      let batter2 = { name: "Batter 2", score: "0 (0)", image: "" };

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

      // 8. Bowler
      const bowlerMatch = body.match(/([A-Z][a-zA-Z\s\.]+)\s+(\d+-\d+)\s*\((\d+\.?\d*)\)/);
      let bowler = { name: "Bowler", figures: "0-0 (0.0)", econ: "0.00", image: "" };

      if (bowlerMatch) {
        const bName = bowlerMatch[1].trim().split("\n").pop();
        const bFigs = `${bowlerMatch[2]} (${bowlerMatch[3]})`;
        let calcEcon = "0.00";
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
        team1: t1 || "KM",
        team1Logo: findImage(t1),
        team2: t2 || "PT",
        team2Logo: findImage(t2),
        score: score || "0/0",
        overs: overs || "0.0",
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

    cachedData = {
      activeMatchId: currentMatchId,
      status: "LIVE",
      ...extracted
    };
  } catch (err) {
    console.warn("Scraping tick warning:", err.message);
  }
}

initBrowser();

app.get("/", (req, res) => {
  res.json({ status: "online", activeMatch: currentMatchId, url: currentMatchUrl });
});

// Non-blocking endpoint accepting ?id=13VD or full url ?url=https://crex.com/...
app.get("/api/score", (req, res) => {
  const reqTarget = req.query.id || req.query.url;
  if (reqTarget && reqTarget.toUpperCase() !== currentMatchId) {
    resolveAndSwitchMatch(reqTarget);
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
