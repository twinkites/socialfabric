#!/usr/bin/env python3
"""Fetch RSS feeds, score sentiment, and write data/latest.json + data/history/<date>.json."""
import json
import re
import sys
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import feedparser
from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS_DIR = ROOT / "scripts"
DATA_DIR = ROOT / "data"
HISTORY_DIR = DATA_DIR / "history"
TREND_DAYS = 14
DRIVERS_PER_CELL = 5
STATE_DRIVERS = 4
STATE_ENTRIES_PER_FEED = 20
COUNTY_DRIVERS = 3
COUNTY_ENTRIES_PER_FEED = 12
USER_AGENT = "Mozilla/5.0 (compatible; SocialFabricBot/1.0; +https://github.com/)"
FETCH_TIMEOUT = 15

vader = SentimentIntensityAnalyzer()

_LEXICON_CACHE = {}


def load_lexicon(lang):
    if lang not in _LEXICON_CACHE:
        path = SCRIPTS_DIR / "lexicons" / f"{lang}.json"
        _LEXICON_CACHE[lang] = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    return _LEXICON_CACHE[lang]


def fetch_entries(url):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT) as resp:
            raw = resp.read()
        parsed = feedparser.parse(raw)
        return parsed.entries or []
    except Exception as exc:  # noqa: BLE001 - one bad feed should never kill the run
        print(f"WARN: failed to fetch {url}: {exc}", file=sys.stderr)
        return []


def entry_text(entry):
    title = entry.get("title", "") or ""
    summary = entry.get("summary", "") or entry.get("description", "") or ""
    summary = re.sub(r"<[^>]+>", " ", summary)
    return title.strip(), f"{title}. {summary}".strip()


def score_en(text):
    return vader.polarity_scores(text)["compound"]


def score_lexicon(text, lang):
    lexicon = load_lexicon(lang)
    if not lexicon:
        return 0.0
    text_lower = text.lower()
    total, count = 0.0, 0
    if lang == "zh":
        for word, val in lexicon.items():
            occurrences = text_lower.count(word)
            if occurrences:
                total += val * occurrences
                count += occurrences
    else:
        words = re.findall(r"[^\W\d_]+", text_lower, re.UNICODE)
        for w in words:
            if w in lexicon:
                total += lexicon[w]
                count += 1
    if count == 0:
        return 0.0
    return max(-1.0, min(1.0, total / count))


def score_text(text, lang):
    if lang == "en":
        return score_en(text)
    return score_lexicon(text, lang)


def load_recent_history(days=TREND_DAYS):
    if not HISTORY_DIR.exists():
        return []
    files = sorted(HISTORY_DIR.glob("[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].json"))[-days:]
    out = []
    for f in files:
        try:
            out.append(json.loads(f.read_text(encoding="utf-8")))
        except Exception:  # noqa: BLE001
            continue
    return out


def trend_for(history, category, region, lang):
    trend = []
    for day in history:
        for cell in day.get("cells", []):
            if cell["category"] == category and cell["region"] == region and cell["lang"] == lang:
                trend.append(cell["score"])
                break
    return trend


def load_recent_state_history(days=TREND_DAYS):
    if not HISTORY_DIR.exists():
        return []
    files = sorted(HISTORY_DIR.glob("states-*.json"))[-days:]
    out = []
    for f in files:
        try:
            out.append(json.loads(f.read_text(encoding="utf-8")))
        except Exception:  # noqa: BLE001
            continue
    return out


def state_trend_for(history, code):
    trend = []
    for day in history:
        for s in day.get("states", []):
            if s["code"] == code:
                trend.append(s["score"])
                break
    return trend


def fetch_states():
    """Coarse per-state proxy: no dedicated state RSS feeds exist at this scale,
    so each state is read via a Google News search for its own name, a rough
    but broad signal of what's being reported about that state right now."""
    states = json.loads((SCRIPTS_DIR / "states.json").read_text(encoding="utf-8"))
    history = load_recent_state_history()
    results = []

    for state in states:
        query = urllib.parse.quote(f'"{state["name"]}" when:2d')
        url = f"https://news.google.com/rss/search?q={query}&hl=en-US&gl=US&ceid=US:en"
        entries = fetch_entries(url)
        items = []
        for entry in entries[:STATE_ENTRIES_PER_FEED]:
            title, text = entry_text(entry)
            if not title:
                continue
            valence = score_en(text)
            items.append({
                "valence": valence,
                "title": title,
                "source": entry.get("source", {}).get("title") if isinstance(entry.get("source"), dict) else "Google News",
                "url": entry.get("link", ""),
            })

        volume = len(items)
        temperature = round((sum(i["valence"] for i in items) / volume + 1) / 2 * 100, 1) if volume else 50.0
        drivers = sorted(items, key=lambda i: abs(i["valence"]), reverse=True)[:STATE_DRIVERS]
        results.append({
            "code": state["code"],
            "name": state["name"],
            "lat": state["lat"],
            "lon": state["lon"],
            "score": temperature,
            "volume": volume,
            "trend": state_trend_for(history, state["code"]) + [temperature],
            "drivers": [
                {"title": d["title"], "source": d["source"] or "Google News", "url": d["url"], "valence": round(d["valence"], 3)}
                for d in drivers
            ],
        })

    return results


def load_recent_county_history(days=TREND_DAYS):
    if not HISTORY_DIR.exists():
        return []
    files = sorted(HISTORY_DIR.glob("counties-*.json"))[-days:]
    out = []
    for f in files:
        try:
            out.append(json.loads(f.read_text(encoding="utf-8")))
        except Exception:  # noqa: BLE001
            continue
    return out


def county_trend_for(history, state, name):
    trend = []
    for day in history:
        for c in day.get("counties", []):
            if c["state"] == state and c["name"] == name:
                trend.append(c["score"])
                break
    return trend


def fetch_counties(state_names):
    """Same coarse search-proxy approach as fetch_states, one level deeper: a
    curated shortlist of each state's top few counties by population (not
    exhaustive, see METHODOLOGY.md), read via a Google News search for
    "<county> County" + the state name."""
    counties = json.loads((SCRIPTS_DIR / "counties.json").read_text(encoding="utf-8"))
    history = load_recent_county_history()
    results = []

    for county in counties:
        state_name = state_names.get(county["state"], county["state"])
        query = urllib.parse.quote(f'"{county["name"]} County" "{state_name}" when:3d')
        url = f"https://news.google.com/rss/search?q={query}&hl=en-US&gl=US&ceid=US:en"
        entries = fetch_entries(url)
        items = []
        for entry in entries[:COUNTY_ENTRIES_PER_FEED]:
            title, text = entry_text(entry)
            if not title:
                continue
            valence = score_en(text)
            items.append({
                "valence": valence,
                "title": title,
                "source": entry.get("source", {}).get("title") if isinstance(entry.get("source"), dict) else "Google News",
                "url": entry.get("link", ""),
            })

        volume = len(items)
        temperature = round((sum(i["valence"] for i in items) / volume + 1) / 2 * 100, 1) if volume else 50.0
        drivers = sorted(items, key=lambda i: abs(i["valence"]), reverse=True)[:COUNTY_DRIVERS]
        results.append({
            "state": county["state"],
            "name": county["name"],
            "lat": county["lat"],
            "lon": county["lon"],
            "score": temperature,
            "volume": volume,
            "trend": county_trend_for(history, county["state"], county["name"]) + [temperature],
            "drivers": [
                {"title": d["title"], "source": d["source"] or "Google News", "url": d["url"], "valence": round(d["valence"], 3)}
                for d in drivers
            ],
        })

    return results


def main():
    feeds = json.loads((SCRIPTS_DIR / "feeds.json").read_text(encoding="utf-8"))
    history = load_recent_history()

    buckets = defaultdict(list)  # (category, region, lang) -> list of (valence, meta)

    for feed in feeds:
        entries = fetch_entries(feed["url"])
        key = (feed["category"], feed["region"], feed["lang"])
        for entry in entries[:25]:
            title, text = entry_text(entry)
            if not title:
                continue
            valence = score_text(text, feed["lang"])
            buckets[key].append({
                "valence": valence,
                "title": title,
                "source": feed["source"],
                "url": entry.get("link", ""),
            })

    cells = []
    weighted_sum, total_volume = 0.0, 0

    for (category, region, lang), items in sorted(buckets.items()):
        if not items:
            continue
        volume = len(items)
        raw_score = sum(i["valence"] for i in items) / volume
        temperature = round((raw_score + 1) / 2 * 100, 1)
        drivers = sorted(items, key=lambda i: abs(i["valence"]), reverse=True)[:DRIVERS_PER_CELL]
        cells.append({
            "category": category,
            "region": region,
            "lang": lang,
            "score": temperature,
            "volume": volume,
            "trend": trend_for(history, category, region, lang) + [temperature],
            "drivers": [
                {"title": d["title"], "source": d["source"], "url": d["url"], "valence": round(d["valence"], 3)}
                for d in drivers
            ],
        })
        weighted_sum += raw_score * volume
        total_volume += volume

    global_raw = (weighted_sum / total_volume) if total_volume else 0.0
    global_score = round((global_raw + 1) / 2 * 100, 1)

    now = datetime.now(timezone.utc)
    latest = {
        "generated_at": now.isoformat(),
        "global_score": global_score,
        "cells": cells,
    }

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    HISTORY_DIR.mkdir(parents=True, exist_ok=True)
    (DATA_DIR / "latest.json").write_text(json.dumps(latest, ensure_ascii=False, indent=2), encoding="utf-8")

    history_snapshot = {
        "date": now.strftime("%Y-%m-%d"),
        "generated_at": now.isoformat(),
        "global_score": global_score,
        "cells": [{"category": c["category"], "region": c["region"], "lang": c["lang"], "score": c["score"]} for c in cells],
    }
    (HISTORY_DIR / f"{history_snapshot['date']}.json").write_text(
        json.dumps(history_snapshot, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    states = fetch_states()
    us_payload = {"generated_at": now.isoformat(), "states": states}
    (DATA_DIR / "us_states.json").write_text(json.dumps(us_payload, ensure_ascii=False, indent=2), encoding="utf-8")

    state_history_snapshot = {
        "date": now.strftime("%Y-%m-%d"),
        "generated_at": now.isoformat(),
        "states": [{"code": s["code"], "score": s["score"]} for s in states],
    }
    (HISTORY_DIR / f"states-{state_history_snapshot['date']}.json").write_text(
        json.dumps(state_history_snapshot, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    state_names = {s["code"]: s["name"] for s in states}
    counties = fetch_counties(state_names)
    counties_payload = {"generated_at": now.isoformat(), "counties": counties}
    (DATA_DIR / "counties.json").write_text(json.dumps(counties_payload, ensure_ascii=False, indent=2), encoding="utf-8")

    county_history_snapshot = {
        "date": now.strftime("%Y-%m-%d"),
        "generated_at": now.isoformat(),
        "counties": [{"state": c["state"], "name": c["name"], "score": c["score"]} for c in counties],
    }
    (HISTORY_DIR / f"counties-{county_history_snapshot['date']}.json").write_text(
        json.dumps(county_history_snapshot, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    # manifest of available history dates, so the frontend can build a scrubber
    # without needing a directory listing (static hosting can't provide one)
    global_dates = sorted(f.stem for f in HISTORY_DIR.glob("[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].json"))
    state_dates = sorted(f.stem.removeprefix("states-") for f in HISTORY_DIR.glob("states-*.json"))
    county_dates = sorted(f.stem.removeprefix("counties-") for f in HISTORY_DIR.glob("counties-*.json"))
    index_payload = {"global": global_dates, "states": state_dates, "counties": county_dates}
    (HISTORY_DIR / "index.json").write_text(json.dumps(index_payload, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"Wrote {len(cells)} cells, global_score={global_score}, total_volume={total_volume}")
    print(f"Wrote {len(states)} states, total_volume={sum(s['volume'] for s in states)}")
    print(f"Wrote {len(counties)} counties, total_volume={sum(c['volume'] for c in counties)}")
    print(f"History index: {len(global_dates)} global, {len(state_dates)} state, {len(county_dates)} county days")


if __name__ == "__main__":
    main()
