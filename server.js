const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { chromium } = require("playwright");

const app = express();
const PORT = process.env.PORT || 10000;

// Enable CORS & Body Parsing
app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Match Registry: maps short_id → crex_url ──────────────────────────────
// IDs are deterministic: first 8 hex chars of SHA256(url)
const _match_registry = {}; // { match_id: crex_url }
let _last_used_url =
  "https://crex.com/cricket-live-score/km-vs-pt-12th-match-odisha-t20-league-2026-match-updates-13VD";

// Seed default match
function _url_to_id(url) {
  return crypto.createHash("sha256").update(url.trim()).digest("hex").slice(0, 8);
}
_match_registry[_url_to_id(_last_used_url)] = _last_used_url;

// ── In-Memory Scrape Cache & Navigation Lock ─────────────────────────────
const _scrape_cache = {}; // { url: { timestamp, data } }
let activeScrapePromise = null;
let browserInstance = null;
let pageInstance = null;

async function getBrowser() {
  if (!browserInstance || !browserInstance.isConnected()) {
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
  }
  return browserInstance;
}

async function getPage() {
  const browser = await getBrowser();
  if (!pageInstance || pageInstance.isClosed()) {
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      viewport: { width: 1280, height: 800 }
    });
    pageInstance = await context.newPage();
    await pageInstance.route("**/*.{mp4,webm,woff,woff2,ttf,css}", (r) => r.abort());
  }
  return pageInstance;
}

// ── Core Scraper Implementation (scrape_crex_match) ──────────────────────
async function scrape_crex_match(rawUrl) {
  const url = rawUrl.trim().replace(/\.+$/, "");

  // Return cached result if scraped within the last 2.5 seconds (prevents Render overload)
  const now = Date.now();
  if (_scrape_cache[url] && now - _scrape_cache[url].timestamp < 2500) {
    return _scrape_cache[url].data;
  }

  // Deduplicate simultaneous requests for the same URL
  if (activeScrapePromise) {
    return activeScrapePromise;
  }

  activeScrapePromise = (async () => {
    try {
      const page = await getPage();

      if (page.url() !== url) {
        console.log(`[Scraper] Navigating to: ${url}`);
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 35000 });
        await page.waitForTimeout(2500);
      }

      const result = await page.evaluate(() => {
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

        // 4. Recent Overs
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

        // 5. Live Ball
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
          success: true,
          team1: team1 || "TEAM 1",
          team1Logo: findImageNearText(team1),
          team2: team2 || "TEAM 2",
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

      _scrape_cache[url] = { timestamp: Date.now(), data: result };
      return result;
    } catch (err) {
      console.error(`[Scraper] Error scraping ${url}:`, err.message);
      return {
        success: false,
        error: `Failed to scrape match: ${err.message}`
      };
    } finally {
      activeScrapePromise = null;
    }
  })();

  return activeScrapePromise;
}

// ──────────────────────────────────────────────────────────────────────────
// API ROUTES (MATCHING PYTHON FLASK LOGIC 1:1)
// ──────────────────────────────────────────────────────────────────────────

// Health Check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", service: "cricket-broadcast-scraper" });
});

// Default URL
app.all("/api/default-url", (req, res) => {
  if (req.method === "POST") {
    const new_url = req.body?.url || req.query?.url;
    if (new_url && new_url.trim()) {
      _last_used_url = new_url.trim();
      return res.json({ success: true, url: _last_used_url });
    }
    return res.status(400).json({ success: false, error: "No URL provided" });
  }
  res.json({ url: _last_used_url });
});

// Register a match URL → get 8-char short ID
app.post("/api/match", (req, res) => {
  const url = (req.body?.url || req.query?.url || "").trim();
  if (!url) {
    return res.status(400).json({ success: false, error: "No URL provided" });
  }

  const match_id = _url_to_id(url);
  _match_registry[match_id] = url;
  _last_used_url = url;

  console.log(`Registered match ${match_id} → ${url}`);
  res.json({ success: true, match_id, url });
});

// Resolve a match ID → URL
app.get("/api/match/:match_id", (req, res) => {
  const url = _match_registry[req.params.match_id];
  if (url) {
    return res.json({ success: true, match_id: req.params.match_id, url });
  }
  res.status(404).json({ success: false, error: "Match ID not found" });
});

// Scrape by match ID
app.get("/api/match/:match_id/scrape", async (req, res) => {
  const url = _match_registry[req.params.match_id];
  if (!url) {
    return res.status(404).json({
      success: false,
      error: "Match ID not found. Please provide a valid Crex URL."
    });
  }

  const data = await scrape_crex_match(url);
  const status = data.success ? 200 : 400;
  res.status(status).json(data);
});

// Scrape by query URL
app.all("/api/scrape", async (req, res) => {
  let url = req.query?.url || req.body?.url;
  if (!url || !url.toString().trim()) {
    return res.status(400).json({
      success: false,
      error: "No Crex match URL provided. Please provide a Crex match link in the ?url= parameter."
    });
  }

  url = url.toString().trim();
  _last_used_url = url;

  const data = await scrape_crex_match(url);
  const status = data.success ? 200 : 400;
  res.status(status).json(data);
});

// Scoreboard compatibility endpoint (reads default URL or custom ?url=)
app.get("/api/score", async (req, res) => {
  let url = req.query?.url || _last_used_url;
  if (url) _last_used_url = url.trim();

  const data = await scrape_crex_match(_last_used_url);
  res.status(200).json(data);
});

// ──────────────────────────────────────────────────────────────────────────

process.on("SIGTERM", async () => {
  if (browserInstance) await browserInstance.close().catch(() => {});
  process.exit(0);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("======================================================");
  console.log(`🏏 Cricket Live Broadcast Server running on:`);
  console.log(`👉 http://0.0.0.0:${PORT}`);
  console.log("Ready to scrape real live data when given a Crex link.");
  console.log("======================================================");
});
