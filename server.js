const express = require("express");
const cors = require("cors");
const { chromium } = require("playwright");

const app = express();

const PORT = process.env.PORT || 10000;

const CREX_URL =
    "https://crex.com/cricket-live-score/bw-vs-ecr-final-european-t20-premier-league-2026-13FP";

app.use(cors({
    origin: [
        "https://preetsports.cu.ma",
        "https://www.preetsports.cu.ma"
    ]
}));
app.use((req, res, next) => {
    console.log(`REQUEST: ${req.method} ${req.url}`);
    next();
});
let browser = null;
let page = null;
let lastData = null;
let lastUpdated = null;
let scraperBusy = false;


// ----------------------------------------------------
// BASIC HELPERS
// ----------------------------------------------------

function clean(value) {
    if (value === null || value === undefined) return "";
    return String(value)
        .replace(/\s+/g, " ")
        .trim();
}

function firstMatch(text, regex, fallback = "") {
    const match = text.match(regex);
    return match ? clean(match[1]) : fallback;
}

function toNumber(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}


// ----------------------------------------------------
// START BROWSER
// ----------------------------------------------------

async function startBrowser() {

    if (browser && page) {
        try {
            await page.title();
            return;
        } catch (error) {
            console.log("Existing browser is not usable. Restarting...");
        }
    }

    console.log("Starting Playwright Chromium...");

    browser = await chromium.launch({
        headless: true,
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu"
        ]
    });

    page = await browser.newPage({
        viewport: {
            width: 1440,
            height: 1000
        },
        userAgent:
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36"
    });

    await page.setExtraHTTPHeaders({
        "Accept-Language": "en-US,en;q=0.9"
    });

    console.log("Playwright Chromium started.");
}


// ----------------------------------------------------
// SCRAPE CREX
// ----------------------------------------------------

async function scrapeCrex() {

    await startBrowser();

    console.log("Opening CREX...");

    await page.goto(CREX_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60000
    });

    // Give CREX/Angular time to render the live page
    await page.waitForTimeout(5000);

    const data = await page.evaluate(() => {

        function clean(value) {
            if (!value) return "";

            return String(value)
                .replace(/\s+/g, " ")
                .trim();
        }

        function getText(element) {
            return clean(element?.innerText || element?.textContent || "");
        }

        function getImage(element) {

            if (!element) return "";

            const img = element.querySelector("img");

            if (!img) return "";

            return (
                img.currentSrc ||
                img.src ||
                img.getAttribute("src") ||
                img.getAttribute("data-src") ||
                ""
            );
        }

        // ------------------------------------------------
        // COMPLETE PAGE TEXT
        // ------------------------------------------------

        const bodyText = getText(document.body);


        // ------------------------------------------------
        // SCORE
        // ------------------------------------------------

        let runs = null;
        let wickets = null;
        let overs = "";

        const scoreElements = [
            ...document.querySelectorAll(".runs.f-runs"),
            ...document.querySelectorAll(".runs"),
            ...document.querySelectorAll(".score")
        ];

        for (const element of scoreElements) {

            const text = getText(element);

            const match = text.match(
                /\b(\d+)\s*-\s*(\d+)\b/
            );

            if (match) {

                runs = Number(match[1]);
                wickets = Number(match[2]);

                const overElement =
                    element.querySelector(".over-text");

                if (overElement) {
                    overs = getText(overElement);
                }

                break;
            }
        }


        // If the score wasn't found from the element,
        // try the page text.
        if (runs === null) {

            const scoreMatch = bodyText.match(
                /\b(\d+)\s*-\s*(\d+)\s*\((\d+(?:\.\d+)?)\)/
            );

            if (scoreMatch) {

                runs = Number(scoreMatch[1]);
                wickets = Number(scoreMatch[2]);
                overs = scoreMatch[3];
            }
        }


        // ------------------------------------------------
        // OVERS
        // ------------------------------------------------

        if (!overs) {

            const overMatch = bodyText.match(
                /\b(\d{1,3}\.\d)\b/
            );

            if (overMatch) {
                overs = overMatch[1];
            }
        }


        // ------------------------------------------------
        // TEAM NAMES
        // ------------------------------------------------

        let battingTeam = "";
        let bowlingTeam = "";

        const heading = document.querySelector("h1");

        if (heading) {

            const headingText = getText(heading);

            const teamMatch = headingText.match(
                /#?\s*([A-Z0-9]{2,})\s+vs\s+([A-Z0-9]{2,})/i
            );

            if (teamMatch) {

                battingTeam = teamMatch[1];
                bowlingTeam = teamMatch[2];
            }
        }


        // Look at obvious team containers
        const teamCandidates = [
            ...document.querySelectorAll(
                ".team-name, .team, .team-title, .team-name-text"
            )
        ];

        const teamNames = [];

        for (const element of teamCandidates) {

            const text = getText(element);

            if (
                text &&
                text.length <= 50 &&
                !teamNames.includes(text)
            ) {
                teamNames.push(text);
            }
        }

        if (!battingTeam && teamNames.length > 0) {
            battingTeam = teamNames[0];
        }

        if (!bowlingTeam && teamNames.length > 1) {
            bowlingTeam = teamNames[1];
        }


        // ------------------------------------------------
        // TEAM LOGOS
        // ------------------------------------------------

        let battingLogo = "";
        let bowlingLogo = "";

        const teamImages = [
            ...document.querySelectorAll(
                'img[alt*="team" i], img[class*="team" i]'
            )
        ];

        if (teamImages.length >= 1) {
            battingLogo =
                teamImages[0].currentSrc ||
                teamImages[0].src ||
                "";
        }

        if (teamImages.length >= 2) {
            bowlingLogo =
                teamImages[1].currentSrc ||
                teamImages[1].src ||
                "";
        }


        // ------------------------------------------------
        // CRR / RRR / TARGET / PARTNERSHIP
        // ------------------------------------------------

        let currentRunRate = "";

        let requiredRunRate = "";

        let target = "";

        let partnership = "";


        const crrMatch = bodyText.match(
            /CRR\s*:\s*([0-9.]+)/i
        );

        if (crrMatch) {
            currentRunRate = crrMatch[1];
        }


        const rrrMatch = bodyText.match(
            /RRR\s*:\s*([0-9.]+)/i
        );

        if (rrrMatch) {
            requiredRunRate = rrrMatch[1];
        }


        const targetMatch = bodyText.match(
            /Target\s*:?\s*(\d+)/i
        );

        if (targetMatch) {
            target = targetMatch[1];
        }


        const targetTextMatch = bodyText.match(
            /need\s+(\d+)\s+runs/i
        );

        if (!target && targetTextMatch) {
            target = targetTextMatch[1];
        }


        const partnershipMatch = bodyText.match(
            /P['’]?ship\s*:\s*([0-9]+\s*\([0-9]+\))/i
        );

        if (partnershipMatch) {
            partnership = partnershipMatch[1];
        }


        // ------------------------------------------------
        // PLAYER CARDS
        // ------------------------------------------------

        const cards = [
            ...document.querySelectorAll(".player-card")
        ];

        const batters = [];

        let bowler = null;


        for (const card of cards) {

            const text = getText(card);

            if (!text) continue;


            // --------------------------------------------
            // BATTER
            // --------------------------------------------

            if (
                /4s\s*:/i.test(text) &&
                /6s\s*:/i.test(text) &&
                /SR\s*:/i.test(text)
            ) {

                let name = "";

                const nameElement =
                    card.querySelector(
                        ".player-name, .batsman-name, .name, a"
                    );

                if (nameElement) {
                    name = getText(nameElement);
                }


                // Extract score such as 90(61)
                const scoreMatch =
                    text.match(
                        /(\d+)\s*\((\d+)\)/
                    );


                const foursMatch =
                    text.match(
                        /4s\s*:\s*(\d+)/i
                    );


                const sixesMatch =
                    text.match(
                        /6s\s*:\s*(\d+)/i
                    );


                const srMatch =
                    text.match(
                        /SR\s*:\s*([0-9.]+)/i
                    );


                if (!name) {

                    const lines = text
                        .split("\n")
                        .map(clean)
                        .filter(Boolean);

                    // Try to find a likely player name
                    for (const line of lines) {

                        if (
                            !/^\d+$/.test(line) &&
                            !/^\d+\(\d+\)$/.test(line) &&
                            !/^4s/i.test(line) &&
                            !/^6s/i.test(line) &&
                            !/^SR/i.test(line)
                        ) {
                            name = line;
                            break;
                        }
                    }
                }


                batters.push({

                    name: name || "BATTER",

                    runs: scoreMatch
                        ? Number(scoreMatch[1])
                        : 0,

                    balls: scoreMatch
                        ? Number(scoreMatch[2])
                        : 0,

                    fours: foursMatch
                        ? Number(foursMatch[1])
                        : 0,

                    sixes: sixesMatch
                        ? Number(sixesMatch[1])
                        : 0,

                    strikeRate: srMatch
                        ? srMatch[1]
                        : "0.00",

                    image: getImage(card)
                });
            }


            // --------------------------------------------
            // BOWLER
            // --------------------------------------------

            if (
                /Econ\s*:/i.test(text) &&
                /\(\d+\.\d+\)/.test(text)
            ) {

                let name = "";

                const nameElement =
                    card.querySelector(
                        ".player-name, .bowler-name, .name, a"
                    );

                if (nameElement) {
                    name = getText(nameElement);
                }


                const figureMatch =
                    text.match(
                        /(\d+)\s*-\s*(\d+)\s*\((\d+(?:\.\d+)?)\)/
                    );


                const economyMatch =
                    text.match(
                        /Econ\s*:\s*([0-9.]+)/i
                    );


                if (!name) {

                    const lines = text
                        .split("\n")
                        .map(clean)
                        .filter(Boolean);

                    for (const line of lines) {

                        if (
                            !/^\d+-\d+/.test(line) &&
                            !/^\d+\.\d+$/.test(line) &&
                            !/^Econ/i.test(line)
                        ) {
                            name = line;
                            break;
                        }
                    }
                }


                bowler = {

                    name: name || "BOWLER",

                    wickets: figureMatch
                        ? Number(figureMatch[1])
                        : 0,

                    runs: figureMatch
                        ? Number(figureMatch[2])
                        : 0,

                    overs: figureMatch
                        ? figureMatch[3]
                        : "0.0",

                    economy: economyMatch
                        ? economyMatch[1]
                        : "0.00",

                    image: getImage(card)
                };
            }
        }


        // ------------------------------------------------
        // RETURN DATA
        // ------------------------------------------------

        return {

            teams: {

                batting: {
                    name: battingTeam || "TEAM A",
                    logo: battingLogo
                },

                bowling: {
                    name: bowlingTeam || "TEAM B",
                    logo: bowlingLogo
                }
            },


            score: {

                runs: runs !== null
                    ? runs
                    : 0,

                wickets: wickets !== null
                    ? wickets
                    : 0,

                overs: overs || "0.0"
            },


            currentRunRate:
                currentRunRate || "--",


            required: {

                rrr:
                    requiredRunRate || "--"
            },


            partnership:
                partnership || "--",


            target:
                target || "--",


            batters:
                batters.slice(0, 2),


            bowler:
                bowler || {

                    name: "BOWLER",
                    wickets: 0,
                    runs: 0,
                    overs: "0.0",
                    economy: "0.00",
                    image: ""
                }
        };
    });


    return data;
}


// ----------------------------------------------------
// UPDATE CACHE
// ----------------------------------------------------

async function updateScore() {

    if (scraperBusy) {
        return;
    }

    scraperBusy = true;

    try {

        console.log("Scraping CREX...");

        const data = await scrapeCrex();

        lastData = {
            status: "online",
            source: "CREX",
            matchUrl: CREX_URL,
            updatedAt: new Date().toISOString(),
            ...data
        };

        lastUpdated = new Date();

        console.log(
            "CREX data updated:",
            JSON.stringify(lastData)
        );

    } catch (error) {

        console.error(
            "CREX scraper error:",
            error.message
        );

        if (!lastData) {

            lastData = {
                status: "error",
                source: "CREX",
                error: error.message
            };
        }

    } finally {

        scraperBusy = false;
    }
}


// ----------------------------------------------------
// API HOME
// ----------------------------------------------------

app.get("/", (req, res) => {

    res.json({
        status: "online",
        service: "Preet Sports Live Score API",
        source: "CREX",
        scraper: "Playwright",
        lastUpdated: lastUpdated
            ? lastUpdated.toISOString()
            : null
    });
});


// ----------------------------------------------------
// SCORE API
// ----------------------------------------------------

app.get("/api/score", async (req, res) => {

    try {

        if (!lastData) {
            await updateScore();
        }

        res.json(lastData);

    } catch (error) {

        res.status(500).json({
            status: "error",
            message: error.message
        });
    }
});


// ----------------------------------------------------
// MANUAL REFRESH
// ----------------------------------------------------

app.get("/api/refresh", async (req, res) => {

    await updateScore();

    res.json({
        status: "refresh-complete",
        data: lastData
    });
});


// ----------------------------------------------------
// AUTOMATIC REFRESH
// ----------------------------------------------------

// Update every 5 seconds
setInterval(() => {

    updateScore().catch(error => {
        console.error(
            "Automatic update error:",
            error.message
        );
    });

}, 5000);


// ----------------------------------------------------
// START SERVER
// ----------------------------------------------------

app.listen(PORT, "0.0.0.0", () => {

    console.log(
        `Preet Sports API running on port ${PORT}`
    );

    console.log(
        `CREX source: ${CREX_URL}`
    );

});
