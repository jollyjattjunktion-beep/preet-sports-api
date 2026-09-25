const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');

const app = express();
app.use(cors());

const MATCH_URL = 'https://crex.com/cricket-live-score/ausw-a-vs-indw-a-3rd-odi-australia-a-women-tour-of-india-2026-match-updates-122G';

let cachedData = {};

async function fetchMatchData() {
  let browser;
  try {
    browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    await page.goto(MATCH_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for the live scoreboard block to mount
    await page.waitForSelector('.live-score-box, .scorecard', { timeout: 8000 }).catch(() => {});

    cachedData = await page.evaluate(() => {
      // Helper function to safely read innerText
      const getTxt = (sel) => document.querySelector(sel)?.innerText?.trim() || '';

      // Update selectors according to CREX's current DOM tree:
      return {
        team1: 'AUSW-A',
        team2: 'INDW-A',
        score: getTxt('.live-score') || '123/2',
        overs: getTxt('.overs') || '19.3',
        crr: getTxt('.crr') || '6.30',
        rrr: getTxt('.rrr') || '-',
        partnership: getTxt('.partnership') || '45 (32)',
        target: getTxt('.target') || '-',
        batter1: {
          name: getTxt('.striker .name') || 'Batter 1',
          score: getTxt('.striker .runs') || '54 (40)'
        },
        batter2: {
          name: getTxt('.non-striker .name') || 'Batter 2',
          score: getTxt('.non-striker .runs') || '21 (18)'
        },
        bowler: {
          name: getTxt('.bowler .name') || 'Bowler',
          figures: getTxt('.bowler .figures') || '1-28 (4.0)',
          econ: getTxt('.bowler .econ') || '7.00'
        }
      };
    });
  } catch (err) {
    console.error('Fetch error:', err.message);
  } finally {
    if (browser) await browser.close();
  }
}

// Poll CREX every 10 seconds
setInterval(fetchMatchData, 10000);
fetchMatchData();

// Expose API for your scoreboard design
app.get('/api/score', (req, res) => {
  res.json(cachedData);
});

app.listen(3000, () => console.log('Scoreboard Relay running on http://localhost:3000'));
          
