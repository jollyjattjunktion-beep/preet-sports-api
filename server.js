const express = require("express");
const cors = require("cors");

const app = express();

const PORT = process.env.PORT || 10000;

app.use(cors({
    origin: [
        "https://preetsports.cu.ma",
        "https://www.preetsports.cu.ma"
    ]
}));

app.get("/", (req, res) => {
    res.json({
        status: "online",
        service: "Preet Sports Live Score API"
    });
});

app.get("/api/score", (req, res) => {
    res.json({
        status: "online",

        teams: {
            batting: {
                name: "TEAM A",
                logo: ""
            },
            bowling: {
                name: "TEAM B",
                logo: ""
            }
        },

        score: {
            runs: 151,
            wickets: 3,
            overs: "18.4"
        },

        currentRunRate: "8.09",

        required: {
            rrr: "9.25"
        },

        partnership: "42 (28)",

        target: "187",

        batters: [
            {
                name: "Batter One",
                runs: 68,
                balls: 42,
                fours: 6,
                sixes: 3,
                strikeRate: "161.90",
                image: ""
            },
            {
                name: "Batter Two",
                runs: 31,
                balls: 24,
                fours: 3,
                sixes: 1,
                strikeRate: "129.17",
                image: ""
            }
        ],

        bowler: {
            name: "Bowler One",
            wickets: 1,
            runs: 28,
            overs: "3.4",
            economy: "7.63",
            image: ""
        }
    });
});

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Preet Sports API running on port ${PORT}`);
});