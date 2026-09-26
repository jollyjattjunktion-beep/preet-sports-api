const express = require("express");
const cors = require("cors");
const { chromium } = require("playwright");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors({ origin: "*" }));
app.use(express.json());

let activeMatchUrl =
  "https://crex.com/cricket-live-score/km-vs-pt-12th-match-odisha-t20-league-2026-match-updates-13VD";

let cachedData = {
  team1: "TEAM 1",
  team1Logo: "",
  team2: "TEAM 2",
  team2Logo: "",
  score: "-/-",
  overs: "0.0",
  liveBall: "🏆",
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

let browser = null;
let page = null;
let isSwitching = false;

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

    console.log("Navigating to:", activeMatchUrl);
    await page.goto(activeMatchUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(3000);

    scrapeLiveData();
    setInterval(scrapeLiveData, 3500);
  } catch (err) {
    console.error("Browser launch error:", err.message);
    setTimeout(initBrowser, 10000);
  }
}

async function loadTargetUrl(newUrl) {
  if (!newUrl || !page || isSwitching) return;
  if (!newUrl.startsWith("http")) return;

  isSwitching = true;
  activeMatchUrl = newUrl.trim();
  console.log("Switching to match URL:", activeMatchUrl);

  // Clear previous score so old match numbers vanish immediately
  cachedData.score = "-/-";
  cachedData.overs = "0.0";
  cachedData.neededRuns = "Loading new match...";

  try {
    await page.goto(activeMatchUrl, { waitUntil: "domcontentloaded", timeout: 35000 });
    await page.waitForTimeout(3000);
    await scrapeLiveData();
  } catch (err) {
    console.error("Navigation error:", err.message);
    cachedData.neededRuns = "Could not load match URL";
  } finally {
    isSwitching = false;
  }
}

async function scrapeLiveData() {
  if (!page || isSwitching) return;

  try {
    const extracted = await page.evaluate(() => {
      const getTxt = (sel) => document.querySelector(sel)?.innerText?.trim() || "";
      const body = document.body.innerText;

      // Image Finder Helper
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

      // 2. Completed Match Status / Winner Detection
      let resultText = "";
      const wonMatch = body.match(/([A-Za-z0-9\-\s]+won\s+by\s+\d+\s+(?:runs|wickets)[^\n\.]*)/i);
      const tieMatch = body.match(/([A-Za-z0-9\-\s]+(?:Match tied|No result|Match abandoned)[^\n\.]*)/i);
      const needMatch = body.match(/([A-Za-z0-9\-]+\s+need\s+\d+\s+runs\s+in\s+\d+\s+balls)/i);

      if (wonMatch) {
        resultText = wonMatch[1].trim() + " 🏆";
      } else if (tieMatch) {
        resultText = tieMatch[1].trim();
      } else if (needMatch) {
        resultText = needMatch[1].trim();
      } else {
        const statusMatch = body.match(/([A-Za-z0-9\-\s]+(?:elected to|lead by|trail by|starts at|delayed)[^\n\.]+)/i);
        resultText = statusMatch ? statusMatch[1].trim() : "Match in Progress";
      }

      // 3. Score & Overs Extraction
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

      // 5. Live Ball / Finish Badge
      let liveBall = "";
      if (wonMatch) {
        liveBall = "FT"; // Full Time / Final
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

      let target = "-";
      const targetMatch = body.match(/Target\s*[:\n]?\s*(\d+)/i);
      if (targetMatch) {
        target = targetMatch[1];
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
          image: findImageNearText(bName)
        };
      }

      return {
        team1: team1 || "TEAM 1",
        team1Logo: findImageNearText(team1),
        team2: team2 || "TEAM 2",
        team2Logo: findImageNearText(team2),
        score,
        overs,
        liveBall,
        neededRuns: resultText,
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
    console.warn("Scrape warning:", err.message);
  }
}

initBrowser();

app.get("/api/score", async (req, res) => {
  const reqUrl = req.query.url;
  if (reqUrl && reqUrl !== activeMatchUrl) {
    await loadTargetUrl(reqUrl);
  }
  res.status(200).json(cachedData);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Preet Sports Relay active on port ${PORT}`);
});
