(() => {
  "use strict";

  const CATEGORY_ORDER = ["world", "markets", "culture", "tech"];
  const CATEGORY_LABEL = { world: "World", markets: "Markets", culture: "Culture", tech: "Tech" };
  const LANG_ORDER = { en: 0, es: 1, zh: 2 };
  const LANG_LABEL = { en: "EN", es: "ES", zh: "ZH" };

  const COLD = [64, 130, 255];    // negative pole, electric indigo-blue
  const NEUTRAL = [122, 118, 150]; // muted violet-gray midpoint
  const WARM = [255, 130, 62];     // positive pole, ember orange
  const IDLE = [48, 52, 64];       // no-data thread color

  // simplified continental US perimeter (lat, lon), traced coarsely.
  // a minimal decorative silhouette, not survey geography
  const USA_OUTLINE = [
    [48.4, -124.7], [43.3, -124.4], [40.0, -124.2], [36.0, -121.9], [32.7, -117.2],
    [31.3, -111.0], [31.8, -108.2], [29.3, -103.5], [25.9, -97.5], [28.0, -97.0],
    [29.2, -89.9], [30.0, -85.7], [27.0, -82.5], [25.1, -80.7], [27.5, -80.3],
    [32.0, -80.9], [35.5, -75.5], [37.3, -76.0], [39.0, -74.9], [40.9, -72.4],
    [41.7, -70.0], [44.8, -67.0], [47.3, -68.4], [45.0, -71.5], [44.8, -73.4],
    [47.5, -88.0], [46.5, -84.5], [49.4, -95.2], [49.0, -99.0], [49.0, -109.5],
    [49.0, -116.0], [49.0, -122.7], [48.4, -124.7],
  ];

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const canvas = document.getElementById("loom");
  const ctx = canvas.getContext("2d");
  const canvasWrap = document.querySelector(".canvas-wrap");
  const ambient = document.getElementById("ambient");
  const stageHint = document.getElementById("stageHint");
  const backControl = document.getElementById("backControl");

  const globalTempEl = document.getElementById("globalTemp");
  const globalLabelEl = document.getElementById("globalLabel");
  const globalUpdatedEl = document.getElementById("globalUpdated");

  const panel = document.getElementById("panel");
  const panelClose = document.getElementById("panelClose");
  const panelEyebrow = document.getElementById("panelEyebrow");
  const panelTitle = document.getElementById("panelTitle");
  const panelScore = document.getElementById("panelScore");
  const panelVolume = document.getElementById("panelVolume");
  const panelTrend = document.getElementById("panelTrend");
  const panelDrivers = document.getElementById("panelDrivers");

  const feedCountEl = document.getElementById("feedCount");
  const langCountEl = document.getElementById("langCount");
  const themeToggle = document.getElementById("themeToggle");
  const scrubber = document.getElementById("scrubber");
  const scrubRange = document.getElementById("scrubRange");
  const scrubLabel = document.getElementById("scrubLabel");

  let dpr = Math.min(window.devicePixelRatio || 1, 2);
  let width = 0, height = 0;

  let rows = [];       // category keys present, in fixed order
  let cols = [];       // {region, lang} present, sorted
  let grid = {};        // grid[i][j] -> cell data or null
  let maxVolume = 1;
  let globalScore = 50;

  let vertices = [];    // flat list of hit-testable nodes for the active view
  let focus = null;     // {kind:'cell', i, j} | {kind:'state', code}
  let pointerInside = false;

  let viewMode = "global"; // "global" | "us" | "county"
  let usData = null;       // {states, bounds, maxVol, edges}, lazy-loaded
  let usLoading = null;
  let countyData = null;   // {counties, byState}, lazy-loaded, all states at once
  let countyLoading = null;
  let selectedState = null; // {code, name}, which state's counties are showing

  let liveData = null;        // parsed data/latest.json, kept around for "live" position
  let historyDates = [];      // sorted list of "YYYY-MM-DD" strings with global history
  const historyCache = {};    // date -> parsed history/<date>.json
  let scoreOverride = null;   // Map "category__region__lang" -> score, or null when live

  const HOVER_RADIUS = { cell: 26, state: 20, county: 20 };

  function sameFocus(a, b) {
    if (!a || !b || a.kind !== b.kind) return false;
    if (a.kind === "cell") return a.i === b.i && a.j === b.j;
    return a.code === b.code;
  }

  function lerp(a, b, t) { return a + (b - a) * t; }

  function scoreColor(score) {
    // score 0..100 -> rgb triple, diverging around 50.
    // Deviation from neutral is perceptually amplified (real-world headline
    // sentiment rarely swings far from center) so the weave still reads as
    // richly colored rather than collapsing to gray.
    const raw = score / 100 - 0.5;
    const boosted = Math.sign(raw) * Math.min(0.5, Math.abs(raw) * 2.1);
    const t = boosted + 0.5;
    let c;
    if (t <= 0.5) {
      const u = t / 0.5;
      c = COLD.map((v, i) => lerp(v, NEUTRAL[i], u));
    } else {
      const u = (t - 0.5) / 0.5;
      c = NEUTRAL.map((v, i) => lerp(v, WARM[i], u));
    }
    return c;
  }

  function rgb(c, a = 1) {
    return `rgba(${c[0] | 0}, ${c[1] | 0}, ${c[2] | 0}, ${a})`;
  }

  function colLabel(col) {
    const base = `${col.region} · ${LANG_LABEL[col.lang] || col.lang.toUpperCase()}`;
    return col.region === "North America" ? `${base} ↗` : base;
  }

  async function loadData() {
    const [dataRes, feedsRes] = await Promise.all([
      fetch("data/latest.json", { cache: "no-store" }),
      fetch("scripts/feeds.json", { cache: "no-store" }).catch(() => null),
    ]);
    const data = await dataRes.json();
    liveData = data;
    buildGrid(data);
    globalScore = data.global_score;
    globalTempEl.textContent = Math.round(data.global_score);
    globalLabelEl.textContent = moodWord(data.global_score);
    globalUpdatedEl.textContent = "updated " + timeAgo(data.generated_at);
    setAmbient(data.global_score);

    if (feedsRes && feedsRes.ok) {
      const feeds = await feedsRes.json();
      feedCountEl.textContent = feeds.length;
      langCountEl.textContent = new Set(feeds.map((f) => f.lang)).size;
    } else {
      feedCountEl.textContent = cols.length;
      langCountEl.textContent = new Set(cols.map((c) => c.lang)).size;
    }

    initScrubber();
  }

  async function initScrubber() {
    try {
      const res = await fetch("data/history/index.json", { cache: "no-store" });
      if (!res.ok) return;
      const index = await res.json();
      historyDates = index.global || [];
    } catch (err) {
      console.error("Failed to load history index:", err);
      return;
    }
    if (historyDates.length < 2) return; // nothing meaningful to scrub through yet

    scrubRange.min = "0";
    scrubRange.max = String(historyDates.length); // last position = live
    scrubRange.value = String(historyDates.length);
    scrubLabel.textContent = "Live";
    if (viewMode === "global") scrubber.hidden = false;

    let scrubTimer = null;
    scrubRange.addEventListener("input", () => {
      const idx = Number(scrubRange.value);
      scrubLabel.textContent = idx === historyDates.length ? "Live" : formatScrubDate(historyDates[idx]);
      clearTimeout(scrubTimer);
      scrubTimer = setTimeout(() => applyScrub(idx), 90);
    });
  }

  function formatScrubDate(dateStr) {
    const d = new Date(`${dateStr}T00:00:00Z`);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
  }

  async function applyScrub(idx) {
    closePanel();
    if (idx === historyDates.length) {
      scoreOverride = null;
      globalScore = liveData.global_score;
      globalTempEl.textContent = Math.round(liveData.global_score);
      globalLabelEl.textContent = moodWord(liveData.global_score);
      globalUpdatedEl.textContent = "updated " + timeAgo(liveData.generated_at);
      setAmbient(liveData.global_score);
      return;
    }
    const date = historyDates[idx];
    let day = historyCache[date];
    if (!day) {
      try {
        const res = await fetch(`data/history/${date}.json`, { cache: "no-store" });
        day = await res.json();
        historyCache[date] = day;
      } catch (err) {
        console.error(`Failed to load history for ${date}:`, err);
        return;
      }
    }
    scoreOverride = new Map(day.cells.map((c) => [`${c.category}__${c.region}__${c.lang}`, c.score]));
    globalScore = day.global_score;
    globalTempEl.textContent = Math.round(day.global_score);
    globalLabelEl.textContent = moodWord(day.global_score);
    globalUpdatedEl.textContent = formatScrubDate(date);
    setAmbient(day.global_score);
  }

  function moodWord(score) {
    if (score >= 70) return "society is running warm";
    if (score >= 56) return "mostly warm";
    if (score >= 44) return "mixed, steady";
    if (score >= 30) return "cooling";
    return "society is running cold";
  }

  function timeAgo(iso) {
    const then = new Date(iso).getTime();
    const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.round(hrs / 24)}d ago`;
  }

  function setAmbient(score) {
    const c = scoreColor(score);
    ambient.style.setProperty("--ambient-color", rgb(c, 0.9));
  }

  function buildGrid(data) {
    const catSet = new Set();
    const colMap = new Map();
    maxVolume = 1;

    data.cells.forEach((cell) => {
      catSet.add(cell.category);
      const key = `${cell.region}__${cell.lang}`;
      if (!colMap.has(key)) colMap.set(key, { region: cell.region, lang: cell.lang });
      maxVolume = Math.max(maxVolume, cell.volume);
    });

    rows = CATEGORY_ORDER.filter((c) => catSet.has(c)).concat(
      [...catSet].filter((c) => !CATEGORY_ORDER.includes(c))
    );
    cols = [...colMap.values()].sort((a, b) => {
      const l = (LANG_ORDER[a.lang] ?? 9) - (LANG_ORDER[b.lang] ?? 9);
      return l !== 0 ? l : a.region.localeCompare(b.region);
    });

    grid = {};
    rows.forEach((r) => {
      grid[r] = {};
    });
    data.cells.forEach((cell) => {
      grid[cell.category][`${cell.region}__${cell.lang}`] = cell;
    });
  }

  function resize() {
    const rect = canvasWrap.getBoundingClientRect();
    width = rect.width;
    height = rect.height;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = width + "px";
    canvas.style.height = height + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  const PAD_LEFT = 64, PAD_RIGHT = 96, PAD_TOP = 56, PAD_BOTTOM = 78;

  function layout() {
    const usableW = Math.max(1, width - PAD_LEFT - PAD_RIGHT);
    const usableH = Math.max(1, height - PAD_TOP - PAD_BOTTOM);
    const colStep = cols.length > 1 ? usableW / (cols.length - 1) : 0;
    const rowStep = rows.length > 1 ? usableH / (rows.length - 1) : 0;
    return {
      x: (j) => cols.length > 1 ? PAD_LEFT + j * colStep : width / 2,
      y: (i) => rows.length > 1 ? PAD_TOP + i * rowStep : height / 2,
    };
  }

  function cellAt(i, j) {
    const row = grid[rows[i]];
    if (!row) return null;
    const col = cols[j];
    const cell = row[`${col.region}__${col.lang}`] || null;
    if (!cell || !scoreOverride) return cell;
    const key = `${rows[i]}__${col.region}__${col.lang}`;
    if (scoreOverride.has(key)) return { ...cell, score: scoreOverride.get(key), historical: true };
    return { ...cell, historical: true, missing: true };
  }

  function widthFor(cell) {
    if (!cell) return 2;
    const v = Math.min(1, cell.volume / maxVolume);
    return lerp(5, 15, Math.sqrt(v));
  }

  let t0 = performance.now();

  // smooth traveling-wave displacement: continuous in `along` so a whole
  // thread reads as one flowing curve rather than independent jitter per point
  function flow(along, cross, amp, time, offset) {
    if (reduceMotion) return 0;
    const phase = along * 0.5 + cross * 0.33 + offset;
    return Math.sin(time * 0.00022 + phase) * amp + Math.sin(time * 0.00011 - phase * 1.4) * amp * 0.4;
  }

  // the whole weave breathes gently in and out, like it's alive
  function breatheScale(time) {
    if (reduceMotion) return 1;
    return 1 + Math.sin(time * 0.00048) * 0.016;
  }

  function drawAmbientGlow(score) {
    const glowC = scoreColor(score);
    const cx = width / 2, cy = height / 2 - 10;
    const bgGlow = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(width, height) * 0.62);
    bgGlow.addColorStop(0, rgb(glowC, 0.16));
    bgGlow.addColorStop(1, rgb(glowC, 0));
    ctx.fillStyle = bgGlow;
    ctx.fillRect(0, 0, width, height);
  }

  function draw(now) {
    const time = now - t0;
    ctx.clearRect(0, 0, width, height);
    if (viewMode === "us") {
      drawUS(time);
    } else if (viewMode === "county") {
      drawCounty(time);
    } else {
      drawGlobalView(time);
    }
    requestAnimationFrame(draw);
  }

  function drawGlobalView(time) {
    if (!rows.length || !cols.length) return;

    const L = layout();
    drawAmbientGlow(globalScore);

    const pts = [];
    const colSpan = Math.max(1, cols.length - 1);
    const rowSpan = Math.max(1, rows.length - 1);
    const breathe = breatheScale(time);
    const bcx = width / 2, bcy = height / 2;
    for (let i = 0; i < rows.length; i++) {
      pts[i] = [];
      // each row/column drapes in a gentle macro arc across its length,
      // alternating direction, so the weave reads as suspended cloth rather
      // than a rigid grid
      for (let j = 0; j < cols.length; j++) {
        const cell = cellAt(i, j);
        const drapeY = Math.sin((j / colSpan) * Math.PI) * (16 + (i % 2) * 5) * (i % 2 === 0 ? 1 : -1);
        const drapeX = Math.sin((i / rowSpan) * Math.PI) * (11 + (j % 2) * 4) * (j % 2 === 0 ? -1 : 1);
        const rawX = L.x(j) + drapeX + flow(j, i, 5, time, 1.5);
        const rawY = L.y(i) + drapeY + flow(i, j, 11, time, 6.2);
        const x = bcx + (rawX - bcx) * breathe;
        const y = bcy + (rawY - bcy) * breathe;
        pts[i][j] = { x, y, cell };
      }
    }

    // flatten vertices for hit-testing
    vertices = [];
    for (let i = 0; i < rows.length; i++) {
      for (let j = 0; j < cols.length; j++) {
        if (pts[i][j].cell) vertices.push({ kind: "cell", i, j, x: pts[i][j].x, y: pts[i][j].y, cell: pts[i][j].cell });
      }
    }
    window.__sfVertices = vertices; // debug hook for local QA

    const segments = [];
    // horizontal segments
    for (let i = 0; i < rows.length; i++) {
      for (let j = 0; j < cols.length - 1; j++) {
        segments.push({
          orient: "h", i, j,
          a: pts[i][j], b: pts[i][j + 1],
          parity: (i + j) % 2,
        });
      }
    }
    // vertical segments
    for (let j = 0; j < cols.length; j++) {
      for (let i = 0; i < rows.length - 1; i++) {
        segments.push({
          orient: "v", i, j,
          a: pts[i][j], b: pts[i + 1][j],
          parity: (i + j + 1) % 2,
        });
      }
    }

    segments.sort((s1, s2) => s1.parity - s2.parity);

    // pass 1: soft bloom underlay (additive), pass 2: crisp woven core
    ctx.globalCompositeOperation = "lighter";
    segments.forEach((seg) => drawSegment(seg, seg.parity === 1, true));
    ctx.globalCompositeOperation = "source-over";
    segments.forEach((seg) => drawSegment(seg, seg.parity === 1, false));

    // crossing glints at data vertices
    ctx.globalCompositeOperation = "lighter";
    vertices.forEach((v) => {
      const isFocus = sameFocus(focus, { kind: "cell", i: v.i, j: v.j });
      const c = scoreColor(v.cell.score);
      const r = isFocus ? 8 : 3.4;
      ctx.beginPath();
      ctx.fillStyle = rgb(c, isFocus ? 1 : 0.9);
      ctx.shadowColor = rgb(c, 1);
      ctx.shadowBlur = isFocus ? 34 : 12;
      ctx.arc(v.x, v.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    });
    ctx.globalCompositeOperation = "source-over";

    drawLabels(L);
  }

  function drawSegment(seg, onTop, bloomPass) {
    const cellA = seg.a.cell, cellB = seg.b.cell;
    const colorA = cellA ? scoreColor(cellA.score) : IDLE;
    const colorB = cellB ? scoreColor(cellB.score) : IDLE;
    const wA = widthFor(cellA), wB = widthFor(cellB);
    const lw = (wA + wB) / 2;

    let alpha = 1;
    if (focus && focus.kind === "cell") {
      const touches = (seg.i === focus.i || seg.i + 1 === focus.i || seg.j === focus.j || seg.j + 1 === focus.j);
      alpha = touches ? 1 : 0.16;
    } else if (!cellA && !cellB) {
      alpha = 0.3;
    }

    const grad = ctx.createLinearGradient(seg.a.x, seg.a.y, seg.b.x, seg.b.y);
    grad.addColorStop(0, rgb(colorA, alpha * (bloomPass ? 0.55 : 1)));
    grad.addColorStop(1, rgb(colorB, alpha * (bloomPass ? 0.55 : 1)));

    ctx.beginPath();
    ctx.strokeStyle = grad;
    ctx.lineCap = "round";

    const mx = (seg.a.x + seg.b.x) / 2;
    const my = (seg.a.y + seg.b.y) / 2;

    if (bloomPass) {
      ctx.lineWidth = lw * 2.6;
      ctx.filter = "blur(6px)";
    } else {
      ctx.lineWidth = lw;
      if (onTop && (cellA || cellB)) {
        ctx.shadowColor = "rgba(0,0,0,0.5)";
        ctx.shadowBlur = 7;
        ctx.shadowOffsetY = 2;
      }
      // faint core highlight so the ribbon reads as a rounded thread, not a flat bar
      ctx.moveTo(seg.a.x, seg.a.y);
      ctx.quadraticCurveTo(mx, my, seg.b.x, seg.b.y);
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;
      ctx.beginPath();
      ctx.strokeStyle = rgb([255, 255, 255], alpha * 0.16);
      ctx.lineWidth = Math.max(1, lw * 0.28);
    }

    ctx.moveTo(seg.a.x, seg.a.y);
    ctx.quadraticCurveTo(mx, my, seg.b.x, seg.b.y);
    ctx.stroke();
    ctx.filter = "none";
  }

  function drawLabels(L) {
    ctx.font = "11px 'IBM Plex Mono', monospace";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(180, 186, 199, 0.8)";
    rows.forEach((r, i) => {
      ctx.textAlign = "right";
      ctx.fillText(CATEGORY_LABEL[r] || r, PAD_LEFT - 18, L.y(i));
    });
    ctx.save();
    ctx.textAlign = "left";
    cols.forEach((c, j) => {
      const x = L.x(j);
      const y = height - PAD_BOTTOM + 24;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(-Math.PI / 9);
      ctx.fillText(colLabel(c), 0, 0);
      ctx.restore();
    });
    ctx.restore();
  }

  async function ensureUSData() {
    if (usData) return usData;
    if (usLoading) return usLoading;
    usLoading = fetch("data/us_states.json", { cache: "no-store" })
      .then((res) => res.json())
      .then((json) => {
        const states = json.states;
        const lons = states.map((s) => s.lon), lats = states.map((s) => s.lat);
        const bounds = {
          minLon: Math.min(...lons), maxLon: Math.max(...lons),
          minLat: Math.min(...lats), maxLat: Math.max(...lats),
        };
        const maxVol = Math.max(1, ...states.map((s) => s.volume));
        // connect each state to its 3 nearest neighbors by projected distance,
        // so the map reads as woven threads rather than isolated dots
        const edges = [];
        const seen = new Set();
        states.forEach((s, idx) => {
          const nearest = states
            .map((o, j) => ({ j, d: j === idx ? Infinity : (o.lon - s.lon) ** 2 + (o.lat - s.lat) ** 2 }))
            .sort((a, b) => a.d - b.d)
            .slice(0, 3);
          nearest.forEach(({ j }) => {
            const key = idx < j ? `${idx}-${j}` : `${j}-${idx}`;
            if (!seen.has(key)) { seen.add(key); edges.push([idx, j]); }
          });
        });
        usData = { states, bounds, maxVol, edges, generatedAt: json.generated_at };
        return usData;
      });
    return usLoading;
  }

  // shared by the US and county views: fit a lon/lat bounding box into the
  // padded canvas area, preserving aspect ratio
  function geoProjection(bounds) {
    const usableW = Math.max(1, width - PAD_LEFT - PAD_RIGHT);
    const usableH = Math.max(1, height - PAD_TOP - PAD_BOTTOM);
    const lonSpan = Math.max(0.01, bounds.maxLon - bounds.minLon);
    const latSpan = Math.max(0.01, bounds.maxLat - bounds.minLat);
    const scale = Math.min(usableW / lonSpan, usableH / latSpan);
    return {
      scale,
      offX: PAD_LEFT + (usableW - lonSpan * scale) / 2,
      offY: PAD_TOP + (usableH - latSpan * scale) / 2,
    };
  }

  function geoPoint(proj, bounds, lat, lon) {
    return {
      x: proj.offX + (lon - bounds.minLon) * proj.scale,
      y: proj.offY + (bounds.maxLat - lat) * proj.scale,
    };
  }

  function drawUsaOutline(proj, bounds, breathe, bcx, bcy) {
    ctx.beginPath();
    USA_OUTLINE.forEach(([lat, lon], idx) => {
      const raw = geoPoint(proj, bounds, lat, lon);
      const x = bcx + (raw.x - bcx) * breathe;
      const y = bcy + (raw.y - bcy) * breathe;
      if (idx === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.strokeStyle = "rgba(210, 214, 224, 0.16)";
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  function drawGeoEdge(a, b, colorA, colorB, bloomPass) {
    const alpha = 0.55;
    const grad = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
    grad.addColorStop(0, rgb(colorA, alpha * (bloomPass ? 0.5 : 1)));
    grad.addColorStop(1, rgb(colorB, alpha * (bloomPass ? 0.5 : 1)));
    ctx.beginPath();
    ctx.strokeStyle = grad;
    ctx.lineCap = "round";
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    if (bloomPass) {
      ctx.lineWidth = 7;
      ctx.filter = "blur(5px)";
    } else {
      ctx.lineWidth = 1.6;
    }
    ctx.moveTo(a.x, a.y);
    ctx.quadraticCurveTo(mx, my, b.x, b.y);
    ctx.stroke();
    ctx.filter = "none";
  }

  // renders a set of glowing nodes + nearest-neighbor threads, shared by the
  // US and county views. `pts` items need {x, y, score, volume, code, label}
  function drawGeoNodes(pts, edges, maxVol, focusKind) {
    ctx.globalCompositeOperation = "lighter";
    edges.forEach(([a, b]) => drawGeoEdge(pts[a], pts[b], scoreColor(pts[a].score), scoreColor(pts[b].score), true));
    ctx.globalCompositeOperation = "source-over";
    edges.forEach(([a, b]) => drawGeoEdge(pts[a], pts[b], scoreColor(pts[a].score), scoreColor(pts[b].score), false));

    ctx.globalCompositeOperation = "lighter";
    pts.forEach((p) => {
      const isFocus = sameFocus(focus, { kind: focusKind, code: p.code });
      const c = scoreColor(p.score);
      const vol = Math.min(1, p.volume / maxVol);
      const r = lerp(4, 13, Math.sqrt(vol)) * (isFocus ? 1.35 : 1);
      ctx.beginPath();
      ctx.fillStyle = rgb(c, isFocus ? 1 : 0.92);
      ctx.shadowColor = rgb(c, 1);
      ctx.shadowBlur = isFocus ? 30 : 10;
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      if (isFocus) {
        ctx.font = "11px 'IBM Plex Mono', monospace";
        ctx.fillStyle = "rgba(237, 238, 240, 0.9)";
        ctx.textAlign = "center";
        ctx.fillText(p.label, p.x, p.y - r - 10);
      }
    });
    ctx.globalCompositeOperation = "source-over";
  }

  function drawUS(time) {
    if (!usData) return;
    const { states, bounds, maxVol, edges } = usData;
    const proj = geoProjection(bounds);
    const usAvg = states.reduce((s, st) => s + st.score, 0) / states.length;
    drawAmbientGlow(usAvg);

    const breathe = breatheScale(time);
    const bcx = width / 2, bcy = height / 2;

    drawUsaOutline(proj, bounds, breathe, bcx, bcy);

    const pts = states.map((s, idx) => {
      const raw = geoPoint(proj, bounds, s.lat, s.lon);
      const x0 = raw.x + flow(idx, idx * 0.7, 3, time, idx * 0.9);
      const y0 = raw.y + flow(idx * 0.6, idx, 3, time, idx * 1.3 + 4);
      return {
        x: bcx + (x0 - bcx) * breathe, y: bcy + (y0 - bcy) * breathe,
        score: s.score, volume: s.volume, code: s.code, label: s.code, state: s,
      };
    });

    vertices = pts.map((p) => ({ kind: "state", x: p.x, y: p.y, state: p.state }));
    window.__sfVertices = vertices;

    drawGeoNodes(pts, edges, maxVol, "state");
  }

  function drawCounty(time) {
    if (!countyData || !selectedState) return;
    const counties = countyData.byState[selectedState.code] || [];
    if (!counties.length) return;

    const lons = counties.map((c) => c.lon), lats = counties.map((c) => c.lat);
    const pad = 0.4; // keeps tightly-clustered states (e.g. Delaware) from over-zooming
    const bounds = {
      minLon: Math.min(...lons) - pad, maxLon: Math.max(...lons) + pad,
      minLat: Math.min(...lats) - pad, maxLat: Math.max(...lats) + pad,
    };
    const proj = geoProjection(bounds);
    const maxVol = Math.max(1, ...counties.map((c) => c.volume));

    const avg = counties.reduce((s, c) => s + c.score, 0) / counties.length;
    drawAmbientGlow(avg);

    const breathe = breatheScale(time);
    const bcx = width / 2, bcy = height / 2;

    const pts = counties.map((c, idx) => {
      const raw = geoPoint(proj, bounds, c.lat, c.lon);
      const x0 = raw.x + flow(idx, idx * 0.7, 3, time, idx * 0.9);
      const y0 = raw.y + flow(idx * 0.6, idx, 3, time, idx * 1.3 + 4);
      return {
        x: bcx + (x0 - bcx) * breathe, y: bcy + (y0 - bcy) * breathe,
        score: c.score, volume: c.volume, code: `${c.state}-${c.name}`, label: c.name, county: c,
      };
    });

    const edges = [];
    const seen = new Set();
    counties.forEach((c, idx) => {
      const nearest = counties
        .map((o, j) => ({ j, d: j === idx ? Infinity : (o.lon - c.lon) ** 2 + (o.lat - c.lat) ** 2 }))
        .sort((a, b) => a.d - b.d)
        .slice(0, 2);
      nearest.forEach(({ j }) => {
        const key = idx < j ? `${idx}-${j}` : `${j}-${idx}`;
        if (!seen.has(key)) { seen.add(key); edges.push([idx, j]); }
      });
    });

    vertices = pts.map((p) => ({ kind: "county", x: p.x, y: p.y, county: p.county }));
    window.__sfVertices = vertices;

    drawGeoNodes(pts, edges, maxVol, "county");
  }

  async function ensureCountyData() {
    if (countyData) return countyData;
    if (countyLoading) return countyLoading;
    countyLoading = fetch("data/counties.json", { cache: "no-store" })
      .then((res) => res.json())
      .then((json) => {
        const byState = {};
        json.counties.forEach((c) => {
          (byState[c.state] = byState[c.state] || []).push(c);
        });
        countyData = { counties: json.counties, byState, generatedAt: json.generated_at };
        return countyData;
      });
    return countyLoading;
  }

  function transitionTo(fn) {
    closePanel();
    canvas.classList.add("view-leaving");
    setTimeout(async () => {
      await fn();
      canvas.classList.remove("view-leaving");
    }, reduceMotion ? 0 : 380);
  }

  function expandToUS() {
    transitionTo(async () => {
      try {
        await ensureUSData();
      } catch (err) {
        console.error("Failed to load US state data:", err);
      }
      viewMode = "us";
      selectedState = null;
      backControl.hidden = false;
      backControl.textContent = "← Global";
      stageHint.textContent = "hover a state to pull a thread · click one to see its counties";
      scrubber.hidden = true;
    });
  }

  function expandToCounty(state) {
    transitionTo(async () => {
      try {
        await ensureCountyData();
      } catch (err) {
        console.error("Failed to load county data:", err);
      }
      viewMode = "county";
      selectedState = state;
      backControl.hidden = false;
      backControl.textContent = "← United States";
      stageHint.textContent = `hover a county in ${state.name} to pull a thread`;
    });
  }

  function collapseToGlobal() {
    transitionTo(async () => {
      viewMode = "global";
      selectedState = null;
      backControl.hidden = true;
      stageHint.textContent = "hover to explore · click North America to zoom into states";
      if (historyDates.length >= 2) scrubber.hidden = false;
    });
  }

  function collapseToUS() {
    transitionTo(async () => {
      viewMode = "us";
      selectedState = null;
      backControl.hidden = false;
      backControl.textContent = "← Global";
      stageHint.textContent = "hover a state to pull a thread · click one to see its counties";
    });
  }

  function goBack() {
    if (viewMode === "county") collapseToUS();
    else if (viewMode === "us") collapseToGlobal();
  }

  function findNearestVertex(mx, my) {
    const threshold = HOVER_RADIUS[viewMode === "us" ? "state" : viewMode === "county" ? "county" : "cell"];
    let best = null, bestD = threshold * threshold;
    vertices.forEach((v) => {
      const d = (v.x - mx) ** 2 + (v.y - my) ** 2;
      if (d < bestD) { bestD = d; best = v; }
    });
    return best;
  }

  function showPanel({ eyebrow, title, score, volume, volumeText, drivers, emptyDriversMessage, trend, focusKey }) {
    focus = focusKey;
    panelEyebrow.textContent = eyebrow;
    panelTitle.textContent = title;
    const c = scoreColor(score);
    panelScore.textContent = Math.round(score);
    panelScore.style.color = rgb(c, 1);
    panelVolume.textContent = volumeText || (volume === 1 ? "1 story tracked" : `${volume} stories tracked`);
    drawTrend(trend && trend.length ? trend : [score]);
    renderDrivers(drivers || [], emptyDriversMessage);
    panel.classList.add("is-open");
    stageHint.classList.add("hidden");
  }

  function openPanelForCell(v) {
    const cell = v.cell;
    const col = cols[v.j];
    const dateLabel = scrubLabel.textContent;
    showPanel({
      eyebrow: `${CATEGORY_LABEL[rows[v.i]] || rows[v.i]} · ${colLabel(col)}`,
      title: cell.missing ? "no data for this date" : moodWord(cell.score),
      score: cell.missing ? 50 : cell.score,
      volume: cell.volume,
      volumeText: cell.historical
        ? (cell.missing ? "No data recorded for this date." : `Temperature as of ${dateLabel}`)
        : undefined,
      drivers: cell.historical ? [] : cell.drivers,
      emptyDriversMessage: cell.historical ? "Headlines aren't stored for past dates." : undefined,
      trend: cell.trend,
      focusKey: { kind: "cell", i: v.i, j: v.j },
    });
  }

  function openPanelForState(v) {
    const s = v.state;
    showPanel({
      eyebrow: `United States · ${s.name} ↗`,
      title: moodWord(s.score),
      score: s.score,
      volume: s.volume,
      drivers: s.drivers,
      trend: s.trend,
      focusKey: { kind: "state", code: s.code },
    });
  }

  function openPanelForCounty(v) {
    const c = v.county;
    showPanel({
      eyebrow: `United States · ${selectedState ? selectedState.name : c.state} · ${c.name} County`,
      title: moodWord(c.score),
      score: c.score,
      volume: c.volume,
      drivers: c.drivers,
      trend: c.trend,
      focusKey: { kind: "county", code: `${c.state}-${c.name}` },
    });
  }

  function closePanel() {
    focus = null;
    panel.classList.remove("is-open");
    stageHint.classList.remove("hidden");
  }

  function drawTrend(trend) {
    while (panelTrend.firstChild) panelTrend.removeChild(panelTrend.firstChild);
    if (!trend.length) return;
    const w = 240, h = 56, pad = 6;
    const min = Math.min(...trend, 0), max = Math.max(...trend, 100);
    const range = Math.max(1, max - min);
    const step = trend.length > 1 ? (w - pad * 2) / (trend.length - 1) : 0;
    const pts = trend.map((s, idx) => {
      const x = pad + idx * step;
      const y = h - pad - ((s - min) / range) * (h - pad * 2);
      return [x, y];
    });
    const path = pts.map((p, idx) => (idx === 0 ? `M${p[0]},${p[1]}` : `L${p[0]},${p[1]}`)).join(" ");
    const ns = "http://www.w3.org/2000/svg";
    const lastColor = rgb(scoreColor(trend[trend.length - 1]), 1);

    const line = document.createElementNS(ns, "path");
    line.setAttribute("d", path);
    line.setAttribute("fill", "none");
    line.setAttribute("stroke", lastColor);
    line.setAttribute("stroke-width", "2");
    line.setAttribute("stroke-linecap", "round");
    line.setAttribute("stroke-linejoin", "round");
    panelTrend.appendChild(line);

    const dot = document.createElementNS(ns, "circle");
    dot.setAttribute("cx", pts[pts.length - 1][0]);
    dot.setAttribute("cy", pts[pts.length - 1][1]);
    dot.setAttribute("r", "3");
    dot.setAttribute("fill", lastColor);
    panelTrend.appendChild(dot);
  }

  function renderDrivers(drivers, emptyMessage) {
    panelDrivers.innerHTML = "";
    if (!drivers.length) {
      const li = document.createElement("li");
      li.textContent = emptyMessage || "No standout stories yet.";
      panelDrivers.appendChild(li);
      return;
    }
    drivers.forEach((d) => {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = d.url || "#";
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = d.title;
      const src = document.createElement("span");
      src.className = "driver-source";
      const arrow = d.valence > 0 ? "↑" : d.valence < 0 ? "↓" : "·";
      src.textContent = `${d.source} ${arrow}`;
      a.appendChild(src);
      li.appendChild(a);
      panelDrivers.appendChild(li);
    });
  }

  function isExpandable(v) {
    if (viewMode === "global") return v.kind === "cell" && cols[v.j].region === "North America";
    if (viewMode === "us") return v.kind === "state";
    return false;
  }

  function vertexFocusKey(v) {
    if (v.kind === "cell") return { kind: "cell", i: v.i, j: v.j };
    if (v.kind === "state") return { kind: "state", code: v.state.code };
    return { kind: "county", code: `${v.county.state}-${v.county.name}` };
  }

  function openPanelForVertex(v) {
    if (v.kind === "cell") openPanelForCell(v);
    else if (v.kind === "state") openPanelForState(v);
    else openPanelForCounty(v);
  }

  function handlePointer(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const mx = clientX - rect.left, my = clientY - rect.top;
    const v = findNearestVertex(mx, my);
    if (v) {
      pointerInside = true;
      if (!sameFocus(focus, vertexFocusKey(v))) openPanelForVertex(v);
      canvas.style.cursor = isExpandable(v) ? "pointer" : "crosshair";
    } else if (pointerInside) {
      pointerInside = false;
      canvas.style.cursor = "crosshair";
    }
  }

  canvas.addEventListener("mousemove", (e) => handlePointer(e.clientX, e.clientY));

  canvas.addEventListener("mouseleave", () => {
    pointerInside = false;
  });

  canvas.addEventListener("touchstart", (e) => {
    const t = e.touches[0];
    if (t) handlePointer(t.clientX, t.clientY);
  }, { passive: true });

  canvas.addEventListener("touchmove", (e) => {
    const t = e.touches[0];
    if (t) handlePointer(t.clientX, t.clientY);
  }, { passive: true });

  canvas.addEventListener("click", (e) => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const v = findNearestVertex(mx, my);
    if (!v || !isExpandable(v)) return;
    if (viewMode === "global") expandToUS();
    else if (viewMode === "us") expandToCounty(v.state);
  });

  panelClose.addEventListener("click", closePanel);
  backControl.addEventListener("click", goBack);

  function syncThemeToggleGlyph() {
    themeToggle.textContent = document.documentElement.dataset.theme === "light" ? "◑" : "◐";
  }

  themeToggle.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("sf-theme", next);
    syncThemeToggleGlyph();
  });
  syncThemeToggleGlyph();

  window.addEventListener("resize", resize);

  panel.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closePanel();
  });

  resize();
  requestAnimationFrame(draw);
  loadData().catch((err) => {
    console.error("Failed to load social fabric data:", err);
    globalLabelEl.textContent = "data unavailable, run scripts/fetch_and_score.py";
  });
})();
