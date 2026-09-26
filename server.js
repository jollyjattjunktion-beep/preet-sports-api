const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { chromium } = require("playwright");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const _match_registry = {};
let _last_used_url =
  "https://crex.com/cricket-live-score/km-vs-pt-12th-match-odisha-t20-league-2026-match-updates-13VD";

// Global team logo cache mapping team names/abbreviations to their /Teams/ vector URLs
const _team_logos = {};

function _url_to_id(url) {
  return crypto.createHash("sha256").update(url.trim()).digest("hex").slice(0, 8);
}
_match_registry[_url_to_id(_last_used_url)] = _last_used_url;

function extractTeamsFromUrl(rawUrl) {
  try {
    const urlObj = new URL(rawUrl);
    const match = urlObj.pathname.match(/(?:cricket-live-score|live-score)\/([a-zA-Z0-9\-]+)-vs-([a-zA-Z0-9\-]+)/i);
    if (match) {
      const t1 = match[1].toUpperCase();
      let t2Raw = match[2];
      const t2Clean = t2Raw.split(/-(?:\d+|match|odi|t20|test|league|cup|tour|final|live|updates)/i)[0].toUpperCase();
      return { team1: t1, team2: t2Clean };
    }
  } catch (e) {}
  return null;
}

const _scrape_cache = {};
let activeScrapePromise = null;
let browserInstance = null;
let pageInstance = null;
let lastLiveScoresHarvest = 0;

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

// Harvests both team logos from div.live-c-w on crex.com/cricket-live-score
async function harvestLogosFromLiveScoresPage() {
  const now = Date.now();
  if (now - lastLiveScoresHarvest < 90000) return; // cache for 90 seconds
  lastLiveScoresHarvest = now;

  try {
    const browser = await getBrowser();
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    });
    const p = await context.newPage();
    await p.route("**/*.{mp4,webm,woff,woff2,ttf,css}", (r) => r.abort());

    await p.goto("https://crex.com/cricket-live-score", { waitUntil: "domcontentloaded", timeout: 25000 });
    await p.waitForTimeout(2000);

    const harvested = await p.evaluate(() => {
      const map = {};
      // 1. Inspect every div.live-c-w card (contains both team-score rows)
      const liveCards = document.querySelectorAll(".live-c-w, [class*='live-card']");
      liveCards.forEach((card) => {
        const teamRows = card.querySelectorAll(".team-score, [class*='team-score']");
        teamRows.forEach((row) => {
          const img = row.querySelector("img");
          const textMatch = row.innerText.trim().match(/^([A-Za-z0-9\-]+)/);
          if (img && textMatch) {
            const src = img.src || img.getAttribute("data-src") || "";
            if (src && src.includes("/Teams/")) {
              map[textMatch[1].toUpperCase()] = src;
            }
          }
        });
      });

      // 2. Scan all team images with alt tags
      document.querySelectorAll("img").forEach((img) => {
        const s = img.src || img.getAttribute("data-src") || "";
        const alt = (img.alt || img.getAttribute("title") || "").trim().toUpperCase();
        if (s && s.includes("/Teams/") && alt && alt.length <= 15) {
          map[alt] = s;
        }
      });

      return map;
    });

    await p.close().catch(() => {});
    await context.close().catch(() => {});

    Object.assign(_team_logos, harvested);
    console.log("[Logos] Harvested logos for teams:", Object.keys(_team_logos));
  } catch (err) {
    console.warn("[Logos] Live scores logo harvest warning:", err.message);
  }
}

async function scrape_crex_match(rawUrl) {
  const url = rawUrl.trim().replace(/\.+$/, "");

  const now = Date.now();
  if (_scrape_cache[url] && now - _scrape_cache[url].timestamp < 2500) {
    return _scrape_cache[url].data;
  }

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

        // 1. Team Logos from /Teams/ CDN on current page
        const teamImgs = Array.from(document.querySelectorAll("img")).filter((img) => {
          const s = img.src || img.getAttribute("data-src") || "";
          return s.includes("/Teams/") || (s.includes("Teams") && !s.includes("players") && !s.includes("svg"));
        });

        let team1Logo = "";
        let team2Logo = "";
        if (teamImgs.length >= 2) {
          team1Logo = teamImgs[0].src || teamImgs[0].getAttribute("data-src") || "";
          team2Logo = teamImgs[1].src || teamImgs[1].getAttribute("data-src") || "";
        } else if (teamImgs.length === 1) {
          team1Logo = teamImgs[0].src || teamImgs[0].getAttribute("data-src") || "";
        }

        // 2. Team Names
        let team1 = "";
        let team2 = "";
        const titleMatch = document.title.match(/(?:Live\s*Score[:\s-]*)?([A-Za-z0-9\-]+)\s+(?:vs|Vs|VS|v|V)\s+([A-Za-z0-9\-]+)/i);
        if (titleMatch) {
          team1 = titleMatch[1].trim();
          team2 = titleMatch[2].trim();
        }

        if (!team1 || !team2) {
          const headerText = document.querySelector("h1, h2, .match-info, .series-name, .header-title")?.innerText || "";
          const headerMatch = headerText.match(/([A-Za-z0-9\-]+)\s+(?:vs|Vs|VS)\s+([A-Za-z0-9\-]+)/i);
          if (headerMatch) {
            team1 = team1 || headerMatch[1].trim();
            team2 = team2 || headerMatch[2].trim();
          }
        }

        // 3. TARGET CREX RESULT BOX (4, 6, Leg Bye, Run Out, Wicket, Over, Lunch Break)
        let liveAction = "";
        const resultBoxEl = document.querySelector(".result-box, .team-result .result-box, div.result-box, .result-box span.font2");
        if (resultBoxEl) {
          liveAction = resultBoxEl.innerText.trim();
        }

        const breakMatch = body.match(/\b(Lunch Break|Tea Break|Innings Break|Dinner Break|Drinks Break|Stumps(?: - Day \d+)?|Day \d+ - Stumps|Rain Delay|Rain stops play|Delayed by rain|Match delayed|Wet Outfield|Bad Light)\b/i);
        const wonMatch = body.match(/([A-Za-z0-9\-\s]+won\s+by\s+\d+\s+(?:runs|wickets)[^\n\.]*)/i);
        const tieMatch = body.match(/([A-Za-z0-9\-\s]+(?:Match tied|No result|Match abandoned)[^\n\.]*)/i);
        const needMatch = body.match(/([A-Za-z0-9\-]+\s+need\s+\d+\s+runs\s+in\s+\d+\s+balls)/i);

        let matchStatus = "";
        if (breakMatch) {
          matchStatus = breakMatch[1].trim();
        } else if (wonMatch) {
          matchStatus = wonMatch[1].trim() + " 🏆";
        } else if (tieMatch) {
          matchStatus = tieMatch[1].trim();
        } else if (needMatch) {
          matchStatus = needMatch[1].trim();
        } else {
          const statusMatch = body.match(/([A-Za-z0-9\-\s]+(?:elected to|lead by|trail by|delayed|starts at|opt to)[^\n\.]+)/i);
          matchStatus = statusMatch ? statusMatch[1].trim() : "Match in Progress";
        }

        if (!liveAction) {
          liveAction = matchStatus;
        }

        // 4. Team Score (CRR Proximity)
        let score = "-/-";
        let overs = "0.0";
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
            best = allMatches.reduce((max, curr) => {
              const maxO = parseFloat(max[3]) || 0;
              const curO = parseFloat(curr[3]) || 0;
              return curO >= maxO ? curr : max;
            }, allMatches[0]);
          }

          score = `${best[1]}/${best[2]}`;
          overs = best[3];
        }

        // 5. Recent Overs
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

        // 6. Live Ball
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

        // 7. Stats Strip
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

        // 8. LAST WICKET WITH RUNS & BALLS (e.g. Ayaz Khan 45(63))
        let lastWicket = "-";
        const lastWktMatch = body.match(/Last\s*Wkt\s*[:\s]*([A-Za-z\s\.\-]+?)\s*(\d+\s*(?:\([0-9]+\))?)/i);
        if (lastWktMatch) {
          const wName = lastWktMatch[1].trim();
          const wScore = lastWktMatch[2].trim();
          lastWicket = `${wName} ${wScore}`;
        } else {
          const lwEl = document.querySelector(".last-wkt, .last-wicket, [class*='last-wkt']");
          if (lwEl && lwEl.innerText.trim()) {
            lastWicket = lwEl.innerText.replace(/Last\s*Wkt\s*[:\s]*/i, "").trim().replace(/\s+/g, " ");
          } else {
            const fallbackWkt = body.match(/Last\s*Wkt\s*[:\s]*([A-Za-z0-9\s\.\-\(\)]+)/i);
            if (fallbackWkt) {
              lastWicket = fallbackWkt[1].trim().split(/\n|CRR|P'ship|Over/i)[0].trim().replace(/\s+/g, " ");
            }
          }
        }

        // 9. NEXT BATSMAN
        let nextBatsman = "-";
        const nextBatMatch = body.match(/(?:Next\s*(?:Batter|Batsman|Bat)|Yet\s*to\s*bat)\s*[:\s]*([A-Za-z\s\.\-]+)/i);
        if (nextBatMatch) {
          nextBatsman = nextBatMatch[1].trim().split(/[,;\n]/)[0].trim();
        } else {
          const nextEl = document.querySelector(".yet-to-bat, .next-batsman, .upcoming-batsman, [class*='yet-to-bat']");
          if (nextEl && nextEl.innerText.trim()) {
            nextBatsman = nextEl.innerText.replace(/(?:Next\s*(?:Batter|Batsman|Bat)|Yet\s*to\s*bat)\s*[:\s]*/i, "").trim().split(/[,;\n]/)[0].trim();
          }
        }

        // 10. Batters
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

        // 11. Bowler
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
          liveAction,
          neededRuns: matchStatus,
          recentOvers: lastTwoOvers,
          crr: crrMatch ? crrMatch[1] : "--",
          rrr: rrrMatch ? rrrMatch[1] : "--",
          target,
          partnership: partMatch ? partMatch[1] : "--",
          lastWicket,
          nextBatsman,
          batter1,
          batter2,
          bowler
        };
      });

      const urlTeams = extractTeamsFromUrl(url);
      if (!extracted.team1 && urlTeams?.team1) extracted.team1 = urlTeams.team1;
      if (!extracted.team2 && urlTeams?.team2) extracted.team2 = urlTeams.team2;

      extracted.team1 = extracted.team1 || urlTeams?.team1 || "TEAM 1";
      extracted.team2 = extracted.team2 || urlTeams?.team2 || "TEAM 2";

      // Cache any logos found on the match page
      if (extracted.team1Logo) _team_logos[extracted.team1.toUpperCase()] = extracted.team1Logo;
      if (extracted.team2Logo) _team_logos[extracted.team2.toUpperCase()] = extracted.team2Logo;

      // Fallback: If second team logo is missing, retrieve from live scores overview cache
      if (!extracted.team2Logo && _team_logos[extracted.team2.toUpperCase()]) {
        extracted.team2Logo = _team_logos[extracted.team2.toUpperCase()];
      }
      if (!extracted.team1Logo && _team_logos[extracted.team1.toUpperCase()]) {
        extracted.team1Logo = _team_logos[extracted.team1.toUpperCase()];
      }

      // If still missing, trigger background harvest from crex.com/cricket-live-score
      if (!extracted.team2Logo) {
        harvestLogosFromLiveScoresPage().catch(() => {});
      }

      extracted.success = true;
      _scrape_cache[url] = { timestamp: Date.now(), data: extracted };
      return extracted;
    } catch (err) {
      console.error(`[Scraper] Error:`, err.message);
      return { success: false, error: err.message };
    } finally {
      activeScrapePromise = null;
    }
  })();

  return activeScrapePromise;
}

// Harvest live overview logos on initial startup
setTimeout(harvestLogosFromLiveScoresPage, 4000);
setInterval(harvestLogosFromLiveScoresPage, 180000);

// ── API Routes (Preserved Exactly) ────────────────────────────────────────

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", service: "cricket-broadcast-scraper" });
});

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

app.post("/api/match", (req, res) => {
  const url = (req.body?.url || req.query?.url || "").trim();
  if (!url) return res.status(400).json({ success: false, error: "No URL provided" });
  const match_id = _url_to_id(url);
  _match_registry[match_id] = url;
  _last_used_url = url;
  res.json({ success: true, match_id, url });
});

app.get("/api/match/:match_id", (req, res) => {
  const url = _match_registry[req.params.match_id];
  if (url) return res.json({ success: true, match_id: req.params.match_id, url });
  res.status(404).json({ success: false, error: "Match ID not found" });
});

app.get("/api/match/:match_id/scrape", async (req, res) => {
  const url = _match_registry[req.params.match_id];
  if (!url) return res.status(404).json({ success: false, error: "Match ID not found." });
  const data = await scrape_crex_match(url);
  res.status(data.success ? 200 : 400).json(data);
});

app.all("/api/scrape", async (req, res) => {
  let url = req.query?.url || req.body?.url;
  if (!url || !url.toString().trim()) {
    return res.status(400).json({ success: false, error: "No Crex match URL provided." });
  }
  url = url.toString().trim();
  _last_used_url = url;
  const data = await scrape_crex_match(url);
  res.status(data.success ? 200 : 400).json(data);
});

app.get("/api/score", async (req, res) => {
  let url = req.query?.url || _last_used_url;
  if (url) _last_used_url = url.trim();
  const data = await scrape_crex_match(_last_used_url);
  res.status(200).json(data);
});

process.on("SIGTERM", async () => {
  if (browserInstance) await browserInstance.close().catch(() => {});
  process.exit(0);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🏏 Cricket Live Broadcast Server running on port ${PORT}`);
});
