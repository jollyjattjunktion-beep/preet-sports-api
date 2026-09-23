const express = require("express");
const cors = require("cors");
const { chromium } = require("playwright");

const app = express();

const PORT = process.env.PORT || 10000;

const CREX_URL =
    "https://crex.com/cricket-live-score/bw-vs-ecr-final-european-t20-premier-league-2026-13FP";

// --------------------------------------------------
// CORS
// --------------------------------------------------

app.use(cors({
    origin: [
        "https://preetsports.cu.ma",
        "https://www.preetsports.cu.ma"
    ]
}));

// --------------------------------------------------
// REQUEST LOGGER
// --------------------------------------------------

app.use((req, res, next) => {
    console.log(`REQUEST: ${req.method} ${req.url}`);
    next();
});

// --------------------------------------------------
// VARIABLES
// --------------------------------------------------

let browser = null;
let page = null;

let cachedData = null;
let lastScrapeTime = null;

let scraping = false;

// --------------------------------------------------
// HELPERS
// --------------------------------------------------

function clean(value) {

    if (value === null || value === undefined) {
        return "";
    }

    return String(value)
        .replace(/\s+/g, " ")
        .trim();
}

function imageFrom(element) {

    if (!element) {
        return "";
    }

    const img = element.querySelector("img");

    if (!img) {
        return "";
    }

    return (
        img.currentSrc ||
        img.src ||
        img.getAttribute("src") ||
        ""
    );
}

// --------------------------------------------------
// START BROWSER
// --------------------------------------------------

async function startBrowser() {

    if (browser && page) {

        try {

            await page.title();

            return;

        } catch (error) {

            console.log("Existing browser unavailable.");

        }
    }

    console.log("Starting Chromium...");

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
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
            "AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/150.0.0.0 Safari/537.36"
    });

    await page.setExtraHTTPHeaders({
        "Accept-Language": "en-US,en;q=0.9"
    });

    console.log("Chromium started.");
}

// --------------------------------------------------
// SCRAPE CREX
// --------------------------------------------------

async function scrapeCREX() {

    await startBrowser();

    console.log("Opening CREX:");

    console.log(CREX_URL);

    await page.goto(CREX_URL, {

        waitUntil: "domcontentloaded",

        timeout: 60000
    });

    console.log("CREX page loaded.");

    // Allow Angular / page data to render
    await page.waitForTimeout(7000);

    const result = await page.evaluate(() => {

        function clean(value) {

            if (!value) {
                return "";
            }

            return String(value)
                .replace(/\s+/g, " ")
                .trim();
        }

        function text(element) {

            if (!element) {
                return "";
            }

            return clean(
                element.innerText ||
                element.textContent ||
                ""
            );
        }

        function getImage(element) {

            if (!element) {
                return "";
            }

            const img = element.querySelector("img");

            if (!img) {
                return "";
            }

            return (
                img.currentSrc ||
                img.src ||
                img.getAttribute("src") ||
                ""
            );
        }

        const body = text(document.body);

        // ------------------------------------------------
        // SCORE
        // ------------------------------------------------

        let runs = 0;
        let wickets = 0;
        let overs = "0.0";

        const runElements = [
            ...document.querySelectorAll(".runs.f-runs"),
            ...document.querySelectorAll(".runs")
        ];

        for (const element of runElements) {

            const value = text(element);

            const match = value.match(
                /(\d+)\s*-\s*(\d+)/
            );

            if (match) {

                runs = Number(match[1]);

                wickets = Number(match[2]);

                const overElement =
                    element.querySelector(".over-text");

                if (overElement) {

                    overs = text(overElement);
                }

                break;
            }
        }

        // ------------------------------------------------
        // OVERS FALLBACK
        // ------------------------------------------------

        if (!overs || overs === "0.0") {

            const match = body.match(
                /\b(\d{1,3}\.\d)\b/
            );

            if (match) {

                overs = match[1];
            }
        }

        // ------------------------------------------------
        // CRR
        // ------------------------------------------------

        let crr = "--";

        const crrMatch = body.match(
            /CRR\s*:?\s*([0-9]+(?:\.[0-9]+)?)/i
        );

        if (crrMatch) {

            crr = crrMatch[1];
        }

        // ------------------------------------------------
        // RRR
        // ------------------------------------------------

        let rrr = "--";

        const rrrMatch = body.match(
            /RRR\s*:?\s*([0-9]+(?:\.[0-9]+)?)/i
        );

        if (rrrMatch) {

            rrr = rrrMatch[1];
        }

        // ------------------------------------------------
        // TARGET
        // ------------------------------------------------

        let target = "--";

        const targetMatch = body.match(
            /Target\s*:?\s*(\d+)/i
        );

        if (targetMatch) {

            target = targetMatch[1];
        }

        // ------------------------------------------------
        // PARTNERSHIP
        // ------------------------------------------------

        let partnership = "--";

        const partnershipMatch = body.match(
            /(?:Partnership|P['’]?ship)\s*:?\s*(\d+\s*\(\d+\))/i
        );

        if (partnershipMatch) {

            partnership =
                partnershipMatch[1];
        }

        // ------------------------------------------------
        // TEAM NAMES
        // ------------------------------------------------

        let battingTeam = "";
        let bowlingTeam = "";

        const teamElements = [
            ...document.querySelectorAll(
                ".team-name, .team-title, .team-name-text"
            )
        ];

        const teams = [];

        for (const element of teamElements) {

            const value = text(element);

            if (
                value &&
                value.length < 50 &&
                !teams.includes(value)
            ) {

                teams.push(value);
            }
        }

        if (teams.length >= 2) {

            battingTeam = teams[0];

            bowlingTeam = teams[1];
        }

        // Try match title
        if (!battingTeam || !bowlingTeam) {

            const match = body.match(
                /([A-Za-z0-9 ]+)\s+vs\s+([A-Za-z0-9 ]+)/i
            );

            if (match) {

                if (!battingTeam) {
                    battingTeam = clean(match[1]);
                }

                if (!bowlingTeam) {
                    bowlingTeam = clean(match[2]);
                }
            }
        }

        // ------------------------------------------------
        // TEAM LOGOS
        // ------------------------------------------------

        let battingLogo = "";
        let bowlingLogo = "";

        const logoElements = [
            ...document.querySelectorAll(
                'img[class*="team" i]'
            )
        ];

        if (logoElements.length >= 1) {

            battingLogo =
                logoElements[0].currentSrc ||
                logoElements[0].src ||
                "";
        }

        if (logoElements.length >= 2) {

            bowlingLogo =
                logoElements[1].currentSrc ||
                logoElements[1].src ||
                "";
        }

        // ------------------------------------------------
        // PLAYER CARDS
        // ------------------------------------------------

        const playerCards = [
            ...document.querySelectorAll(".player-card")
        ];

        const batters = [];

        let bowler = null;

        for (const card of playerCards) {

            const value = text(card);

            if (!value) {
                continue;
            }

            // --------------------------------------------
            // BATTER
            // --------------------------------------------

            if (
                /4s\s*:/i.test(value) &&
                /6s\s*:/i.test(value) &&
                /SR\s*:/i.test(value)
            ) {

                let name = "";

                const nameElement =
                    card.querySelector(
                        ".player-name, .batsman-name, .name"
                    );

                if (nameElement) {

                    name = text(nameElement);
                }

                const scoreMatch =
                    value.match(
                        /(\d+)\s*\((\d+)\)/
                    );

                const foursMatch =
                    value.match(
                        /4s\s*:\s*(\d+)/i
                    );

                const sixesMatch =
                    value.match(
                        /6s\s*:\s*(\d+)/i
                    );

                const srMatch =
                    value.match(
                        /SR\s*:\s*([0-9.]+)/i
                    );

                if (!name) {

                    const lines =
                        value
                            .split("\n")
                            .map(clean)
                            .filter(Boolean);

                    if (lines.length > 0) {

                        name = lines[0];
                    }
                }

                batters.push({

                    name:
                        name || "BATTER",

                    runs:
                        scoreMatch
                            ? Number(scoreMatch[1])
                            : 0,

                    balls:
                        scoreMatch
                            ? Number(scoreMatch[2])
                            : 0,

                    fours:
                        foursMatch
                            ? Number(foursMatch[1])
                            : 0,

                    sixes:
                        sixesMatch
                            ? Number(sixesMatch[1])
                            : 0,

                    strikeRate:
                        srMatch
                            ? srMatch[1]
                            : "0.00",

                    image:
                        getImage(card)
                });
            }

            // --------------------------------------------
            // BOWLER
            // --------------------------------------------

            if (
                /Econ\s*:/i.test(value)
            ) {

                let name = "";

                const nameElement =
                    card.querySelector(
                        ".player-name, .bowler-name, .name"
                    );

                if (nameElement) {

                    name = text(nameElement);
                }

                const figureMatch =
                    value.match(
                        /(\d+)\s*-\s*(\d+)\s*\((\d+(?:\.\d+)?)\)/
                    );

                const economyMatch =
                    value.match(
                        /Econ\s*:\s*([0-9.]+)/i
                    );

                if (!name) {

                    const lines =
                        value
                            .split("\n")
                            .map(clean)
                            .filter(Boolean);

                    if (lines.length > 0) {

                        name = lines[0];
                    }
                }

                bowler = {

                    name:
                        name || "BOWLER",

                    wickets:
                        figureMatch
                            ? Number(figureMatch[1])
                            : 0,

                    runs:
                        figureMatch
                            ? Number(figureMatch[2])
                            : 0,

                    overs:
                        figureMatch
                            ? figureMatch[3]
                            : "0.0",

                    economy:
                        economyMatch
                            ? economyMatch[1]
                            : "0.00",

                    image:
                        getImage(card)
                };
            }
        }

        // ------------------------------------------------
        // RETURN
        // ------------------------------------------------

        return {

            teams: {

                batting: {

                    name:
                        battingTeam ||
                        "UNKNOWN",

                    logo:
                        battingLogo
                },

                bowling: {

                    name:
                        bowlingTeam ||
                        "UNKNOWN",

                    logo:
                        bowlingLogo
                }
            },

            score: {

                runs:
                    runs,

                wickets:
                    wickets,

                overs:
                    overs
            },

            currentRunRate:
                crr,

            required: {

                rrr:
                    rrr
            },

            partnership:
                partnership,

            target:
                target,

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

    return result;
}

// --------------------------------------------------
// UPDATE SCORE
// --------------------------------------------------

async function updateScore() {

    if (scraping) {

        console.log(
            "Scraper already running..."
        );

        return;
    }

    scraping = true;

    try {

        console.log(
            "--------------------------------"
        );

        console.log(
            "Starting CREX scrape..."
        );

        const data =
            await scrapeCREX();

        cachedData = {

            status: "online",

            source: "CREX",

            matchUrl: CREX_URL,

            updatedAt:
                new Date().toISOString(),

            ...data
        };

        lastScrapeTime =
            new Date();

        console.log(
            "CREX scrape successful."
        );

        console.log(
            JSON.stringify(
                cachedData,
                null,
                2
            )
        );

    } catch (error) {

        console.error(
            "CREX ERROR:",
            error.message
        );

        if (!cachedData) {

            cachedData = {

                status: "error",

                source: "CREX",

                error:
                    error.message,

                matchUrl:
                    CREX_URL
            };
        }

    } finally {

        scraping = false;
    }
}

// --------------------------------------------------
// HOME
// --------------------------------------------------

app.get("/", (req, res) => {

    res.json({

        status: "online",

        service:
            "Preet Sports Live Score API",

        source:
            "CREX",

        lastUpdated:
            lastScrapeTime
                ? lastScrapeTime.toISOString()
                : null
    });
});

// --------------------------------------------------
// SCORE API
// --------------------------------------------------

app.get("/api/score", async (req, res) => {

    console.log(
        "Score API requested."
    );

    if (!cachedData) {

        await updateScore();
    }

    res.json(
        cachedData
    );
});

// --------------------------------------------------
// FORCE REFRESH
// --------------------------------------------------

app.get("/api/refresh", async (req, res) => {

    console.log(
        "Manual CREX refresh requested."
    );

    await updateScore();

    res.json(
        cachedData
    );
});

// --------------------------------------------------
// AUTOMATIC REFRESH
// --------------------------------------------------

setInterval(() => {

    updateScore().catch(error => {

        console.error(
            "Automatic scraper error:",
            error.message
        );
    });

}, 10000);

// --------------------------------------------------
// START SERVER
// --------------------------------------------------

app.listen(
    PORT,
    "0.0.0.0",
    () => {

        console.log(
            `Preet Sports API running on port ${PORT}`
        );

        console.log(
            `CREX source: ${CREX_URL}`
        );
    }
);
