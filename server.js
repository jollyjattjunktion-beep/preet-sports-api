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

// Cache for live match cards harvested from crex.com/cricket-live-score
let _live_matches_cache = [];
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
      const t2Clean = t2Raw.split(/-(?:\d+|match|odi|t20|test|league|cup|tour|final|live|updates|scorecard)/i)[0].toUpperCase();
      return { team1: t1, team2: t2Clean };
    }
  } catch (e) {}
  return null;
}

const _scrape_cache = {};
let activeScrapePromise = null;
let browserInstance = null;
let matchPageInstance = null;
let overviewPageInstance = null;
let lastOverviewHarvestTime = 0;

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

async function getMatchPage() {
  const browser = await getBrowser();
  if (!matchPageInstance || matchPageInstance.isClosed()) {
    const context = browser.contexts()[0] || (await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      viewport: { width: 1280, height: 800 }
    }));
    matchPageInstance = await context.newPage();
    await matchPageInstance.route("**/*.{mp4,webm,woff,woff2,ttf,css}", (r) => r.abort());
  }
  return matchPageInstance;
}

async function getOverviewPage() {
  const browser = await getBrowser();
  if (!overviewPageInstance || overviewPageInstance.isClosed()) {
    const context = browser.contexts()[0] || (await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      viewport: { width: 1280, height: 800 }
    }));
    overviewPageInstance = await context.newPage();
    await overviewPageInstance.route("**/*.{mp4,webm,woff,woff2,ttf,css}", (r) => r.abort());
  }
  return overviewPageInstance;
}

// Harvest all live match cards from crex.com/cricket-live-score
async function harvestFromLiveScoresPage() {
  const now = Date.now();
  if (now - lastOverviewHarvestTime < 45000 && _live_matches_cache.length > 0) {
    return;
  }
  lastOverviewHarvestTime = now;

  try {
    const p = await getOverviewPage();
    if (p.url() !== "https://crex.com/cricket-live-score") {
      await p.goto("https://crex.com/cricket-live-score", { waitUntil: "domcontentloaded", timeout: 30000 });
      await p.waitForTimeout(2000);
    } else {
      await p.reload({ waitUntil: "domcontentloaded", timeout: 25000 });
      await p.waitForTimeout(1500);
    }

    const cards = await p.evaluate(() => {
      const results = [];
      const cardNodes = document.querySelectorAll(".live-card-wrapper, .live-card, [class*='live-card']");
      cardNodes.forEach((card) => {
        const a = card.querySelector("a[href*='/cricket-live-score/']") || card.closest("a") || card.querySelector("a");
        if (!a) return;
        const href = a.getAttribute("href") || a.href || "";

        const liveCw = card.querySelector(".live-c-w") || card;
        const teamRows = liveCw.querySelectorAll(".team-score, [class*='team-score']");

        if (teamRows.length >= 2) {
          const parseRow = (row) => {
            const img = row.querySelector("img");
            const logo = img ? (img.src || img.getAttribute("data-src") || "") : "";
            const rawText = row.innerText.trim();
            const nameMatch = rawText.match(/^([A-Za-z0-9\-]+)/);
            const name = nameMatch ? nameMatch[1].toUpperCase() : "";
            return { name, logo };
          };

          const t1 = parseRow(teamRows[0]);
          const t2 = parseRow(teamRows[1]);

          if (t1.name && t2.name) {
            results.push({
              href,
              team1: t1,
              team2: t2
            });
          }
        }
      });
      return results;
    });

    if (cards && cards.length > 0) {
      _live_matches_cache = cards;
      for (const c of cards) {
        if (c.team1.name && c.team1.logo) _team_logos[c.team1.name] = c.team1.logo;
        if (c.team2.name && c.team2.logo) _team_logos[c.team2.name] = c.team2.logo;
      }
      console.log(`[Overview] Synced ${cards.length} live matches from crex.com/cricket-live-score`);
    }
  } catch (err) {
    console.warn("[Overview] Live overview harvest warning:", err.message);
  }
}

function findMatchLogosFromOverview(matchUrl, team1Name, team2Name) {
  if (!matchUrl && !team1Name) return null;
  const cleanUrl = (matchUrl || "").toLowerCase();
  const slug = cleanUrl.split("/").filter(Boolean).pop() || "";

  // 1. Direct URL Slug Match
  for (const m of _live_matches_cache) {
    const cardSlug = (m.href || "").toLowerCase().split("/").filter(Boolean).pop() || "";
    if (slug && cardSlug && (slug.includes(cardSlug) || cardSlug.includes(slug))) {
      return m;
    }
  }

  // 2. Team Name Matching
  const t1 = (team1Name || "").toUpperCase();
  const t2 = (team2Name || "").toUpperCase();
  if (t1 && t2) {
    for (const m of _live_matches_cache) {
      if (
        (m.team1.name === t1 && m.team2.name === t2) ||
        (m.team1.name === t2 && m.team2.name === t1)
      ) {
        return m;
      }
    }
  }

  return null;
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
      const page = await getMatchPage();

      if (page.url() !== url) {
        console.log(`[Scraper] Navigating to: ${url}`);
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 35000 });
        await page.waitForTimeout(2500);
      }

      const baseUrl = url.replace(/\/match-(?:updates|scorecard|info|live).*$/i, "");
      const scorecardUrl = baseUrl + "/match-scorecard";

      const extracted = await page.evaluate(async (scUrl) => {
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

        // 1. Team Names
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

        // 2. Identify batting team logo accurately on current match page
        let liveTeamLogo = "";
        let liveTeamName = "";
        const inningBox = document.querySelector(".team-inning, .live-score-card, .team-score");
        if (inningBox) {
          const img = inningBox.querySelector("img");
          if (img) liveTeamLogo = img.src || img.getAttribute("data-src") || "";
          const textMatch = inningBox.innerText.trim().match(/^([A-Za-z0-9\-]+)/);
          if (textMatch) liveTeamName = textMatch[1].toUpperCase();
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

        // 8. LAST WICKET WITH RUNS & BALLS
        let lastWicket = "-";
        const lastWktMatch = body.match(/Last\s*Wkt\s*[:\s]*([A-Za-z\s\.\-]+?)\s*(\d+\s*(?:\([0-9]+\))?)/i);
        if (lastWktMatch) {
          lastWicket = `${lastWktMatch[1].trim()} ${lastWktMatch[2].trim()}`;
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

        // 10. Fetch 4s, 6s, and SR from Scorecard
        const scorecardBatters = {};
        try {
          const scRes = await fetch(scUrl);
          if (scRes.ok) {
            const scHtml = await scRes.text();
            const scDoc = new DOMParser().parseFromString(scHtml, "text/html");
            scDoc.querySelectorAll("tr").forEach((tr) => {
              const cells = Array.from(tr.querySelectorAll("td, th")).map((c) => c.innerText.trim());
              if (cells.length >= 7) {
                const bName = cells[0];
                const r = cells[2];
                const b = cells[3];
                const fours = cells[4];
                const sixes = cells[5];
                const sr = cells[6];
                if (bName && !isNaN(parseInt(r)) && !isNaN(parseInt(b))) {
                  scorecardBatters[bName.toLowerCase()] = { name: bName, runs: r, balls: b, fours, sixes, sr };
                }
              }
            });
          }
        } catch (e) {}

        const findScorecardBatter = (shortName) => {
          if (!shortName) return null;
          const s = shortName.toLowerCase().trim();
          if (scorecardBatters[s]) return scorecardBatters[s];
          const parts = s.split(/\s+/);
          const lastName = parts[parts.length - 1];
          for (const k in scorecardBatters) {
            if (k.includes(lastName) || lastName.includes(k)) {
              return scorecardBatters[k];
            }
          }
          return null;
        };

        // 11. Batters
        const batterMatches = [...body.matchAll(/([A-Z][a-zA-Z\s\.]+)\s*\*?\s+(\d+)\s*\(([0-9]+)\)/g)];
        let batter1 = { name: "Batter 1", score: "-", fours: "0", sixes: "0", sr: "0.00", image: "" };
        let batter2 = { name: "Batter 2", score: "-", fours: "0", sixes: "0", sr: "0.00", image: "" };

        if (batterMatches.length >= 1) {
          const b1Name = batterMatches[0][1].trim().split("\n").pop();
          const b1R = batterMatches[0][2];
          const b1B = batterMatches[0][3];
          const scb1 = findScorecardBatter(b1Name);
          let sr1 = "0.00";
          if (parseFloat(b1B) > 0) sr1 = ((parseFloat(b1R) / parseFloat(b1B)) * 100).toFixed(2);

          batter1 = {
            name: b1Name,
            score: `${b1R} (${b1B})`,
            fours: scb1 ? scb1.fours : "0",
            sixes: scb1 ? scb1.sixes : "0",
            sr: scb1 ? scb1.sr : sr1,
            image: findImageNearText(b1Name)
          };
        }

        if (batterMatches.length >= 2) {
          const b2Name = batterMatches[1][1].trim().split("\n").pop();
          const b2R = batterMatches[1][2];
          const b2B = batterMatches[1][3];
          const scb2 = findScorecardBatter(b2Name);
          let sr2 = "0.00";
          if (parseFloat(b2B) > 0) sr2 = ((parseFloat(b2R) / parseFloat(b2B)) * 100).toFixed(2);

          batter2 = {
            name: b2Name,
            score: `${b2R} (${b2B})`,
            fours: scb2 ? scb2.fours : "0",
            sixes: scb2 ? scb2.sixes : "0",
            sr: scb2 ? scb2.sr : sr2,
            image: findImageNearText(b2Name)
          };
        }

        // 12. Bowler
        const bowlerMatch = body.match(/([A-Z][a-zA-Z\s\.]+)\s+(\d+-\d+)\s*\((\d+\.?\d*)\)/);
        let bowler = { name: "Bowler", figures: "-", econ: "0.00", image: "" };

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
          team1,
          team2,
          liveTeamLogo,
          liveTeamName,
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
      }, scorecardUrl);

      // Determine team names
      const urlTeams = extractTeamsFromUrl(url);
      if (!extracted.team1 && urlTeams?.team1) extracted.team1 = urlTeams.team1;
      if (!extracted.team2 && urlTeams?.team2) extracted.team2 = urlTeams.team2;
      extracted.team1 = extracted.team1 || urlTeams?.team1 || "TEAM 1";
      extracted.team2 = extracted.team2 || urlTeams?.team2 || "TEAM 2";

      // 13. ACCURATE LOGO RESOLUTION USING CREX.COM/CRICKET-LIVE-SCORE
      let team1Logo = "";
      let team2Logo = "";

      const matchOverview = findMatchLogosFromOverview(url, extracted.team1, extracted.team2);

      if (matchOverview) {
        if (matchOverview.team1.name === extracted.team1.toUpperCase()) {
          team1Logo = matchOverview.team1.logo;
          team2Logo = matchOverview.team2.logo;
        } else if (matchOverview.team2.name === extracted.team1.toUpperCase()) {
          team1Logo = matchOverview.team2.logo;
          team2Logo = matchOverview.team1.logo;
        }
      }

      // Fallbacks from global team cache
      if (!team1Logo && _team_logos[extracted.team1.toUpperCase()]) {
        team1Logo = _team_logos[extracted.team1.toUpperCase()];
      }
      if (!team2Logo && _team_logos[extracted.team2.toUpperCase()]) {
        team2Logo = _team_logos[extracted.team2.toUpperCase()];
      }

      // If one team is actively batting on the match page, pair its logo strictly to that team
      if (extracted.liveTeamLogo && extracted.liveTeamName) {
        if (extracted.liveTeamName === extracted.team1.toUpperCase()) {
          team1Logo = team1Logo || extracted.liveTeamLogo;
          _team_logos[extracted.team1.toUpperCase()] = team1Logo;
        } else if (extracted.liveTeamName === extracted.team2.toUpperCase()) {
          team2Logo = team2Logo || extracted.liveTeamLogo;
          _team_logos[extracted.team2.toUpperCase()] = team2Logo;
        }
      }

      extracted.team1Logo = team1Logo;
      extracted.team2Logo = team2Logo;

      // If either logo is still missing, schedule an overview sync
      if (!team1Logo || !team2Logo) {
        harvestFromLiveScoresPage().catch(() => {});
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

// Initial background harvest of crex.com/cricket-live-score
setTimeout(harvestFromLiveScoresPage, 2500);
setInterval(harvestFromLiveScoresPage, 60000);

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
