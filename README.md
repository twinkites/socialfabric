# Social Fabric

**See the mood of the world.** Social Fabric is a static site that turns live RSS feeds into a woven, animated visualization of public sentiment, from global news down to US states and counties. No server, no tracking, no ads.

## Core Features

The homepage renders a glowing thread grid: rows are news categories (world, markets, culture, tech), columns are region/language combinations. Thread color runs cold (negative) to warm (positive), thread thickness tracks coverage volume, and hovering a crossing opens a detail panel with the score, a trend sparkline, and the headlines driving it.

Clicking North America zooms into a state-by-state map of the US, plotted from real geography with a minimal outline overlay. Clicking a state zooms further into its top counties by population. Both levels use the same glowing thread visuals and hover panel as the global view, with breadcrumb navigation back out.

The whole canvas breathes gently and drifts with a slow current. Dark and light themes are both supported; the weave itself always renders against a dark stage so the glow reads consistently either way. A scrubber above the global view lets you drag back through past days and replay how the weave looked then.

## Data Pipeline

GitHub Pages only serves static files, and most RSS feeds block browser CORS requests, so there's no way to fetch live in the browser. A scheduled GitHub Actions workflow (`.github/workflows/update-data.yml`) runs `scripts/fetch_and_score.py` every 3 hours: it reads ~110 curated RSS feeds plus search-based passes for US states and counties, scores each entry for sentiment, and commits the results to `data/`. The frontend just fetches those JSON files at load, same origin, no CORS issues.

Scoring uses VADER for English and curated word-valence lexicons for Spanish and Chinese. Full pipeline details, known limitations, and the legal notice live in [METHODOLOGY.md](METHODOLOGY.md).

## Technical Structure

Vanilla HTML, CSS, and JavaScript. No build step, no framework. `app.js` renders the visualization on a single canvas with three view modes (global, US states, US counties) sharing one projection and rendering pipeline. `scripts/fetch_and_score.py` is the only Python in the project; its dependencies are in `scripts/requirements.txt`.

```
social_fabric/
├── .github/workflows/update-data.yml   cron job: fetch, score, commit
├── scripts/
│   ├── feeds.json                      feed registry
│   ├── states.json / counties.json     US drill-down registries
│   ├── fetch_and_score.py              the whole pipeline
│   └── lexicons/{es,zh}.json           word-valence maps (English uses VADER)
├── data/
│   ├── latest.json / us_states.json / counties.json   current snapshots
│   └── history/                        daily rollups, power the trend sparklines
├── assets/twinkites-logo.png
├── index.html / style.css / app.js
```

## Running Locally

```bash
python3 -m venv .venv
.venv/bin/pip install -r scripts/requirements.txt
.venv/bin/python scripts/fetch_and_score.py   # generates data/*.json
python3 -m http.server 8000
# open http://localhost:8000
```

## Deploying

Push to GitHub, then set Pages to serve from `main`, root. The `update-data` workflow needs no secrets. It only reads public RSS feeds and commits back with the default `GITHUB_TOKEN`.

## License

MIT © 2026 [Twin Kites LLC](https://twinkites.com/). Social Fabric is not a news source or a sentiment survey; treat its scores as approximate, not authoritative.
