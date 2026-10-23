// Stats pages: hash-routed, data from /api/stats/*, charts with Observable Plot (global `Plot` + `d3` from the CDN).
import { lineColor } from "./colors.js";

const main = document.getElementById("page");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const fmt = new Intl.NumberFormat("de-CH");
const n0 = (x) => (x == null ? "–" : fmt.format(Math.round(x)));
const ZH = "Europe/Zurich"; // Swiss trains: Swiss time, wherever the viewer is
const time = (sec) => new Date(sec * 1000).toLocaleTimeString("de-CH", { hour: "2-digit", minute: "2-digit", timeZone: ZH });
const hm = (d) => d.toLocaleTimeString("de-CH", { hour: "2-digit", minute: "2-digit", timeZone: ZH }); // Plot time axes
const ymdZH = (sec) => new Date(sec * 1000).toLocaleDateString("sv-SE", { timeZone: ZH }); // YYYY-MM-DD
const todayZH = () => ymdZH(Date.now() / 1000);
const dm = (sec) => new Date(sec * 1000).toLocaleDateString("de-CH", { day: "2-digit", month: "2-digit", timeZone: ZH });
/** Time, with the date in front when it isn't today. */
const when = (sec) => (ymdZH(sec) === todayZH() ? time(sec) : `${dm(sec)} ${time(sec)}`);
const mins = (sec) => (sec == null ? "–" : `${sec >= 30 ? "+" : ""}${Math.round(sec / 60)}′`);
const day = (date) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

/**
 * Stats JSON. While the server restarts (404/502/503/504 from the proxy, or no answer at all) it retries for up to two minutes and says so,
 * instead of failing the page. `missingOk`: a 404 means "unknown train/station", not an error.
 */
async function api(p, missingOk = false) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(`/api/stats/${p}`).catch(() => null);
    if (r?.ok) return r.json();
    if (r?.status === 404 && missingOk) return null;
    // while the container restarts the proxy answers 404 (no backend) or 502: on pages that always exist, that means "wait"
    if ((r && ![404, 502, 503, 504].includes(r.status)) || attempt >= 15) throw new Error(r ? `HTTP ${r.status}` : "no connection");
    const wait = Math.min(8, Number(r?.headers.get("retry-after")) || 5); // short steps: the timetable is usually back within ~30 s
    if (!main.querySelector(".kpis")) main.innerHTML = `<div class="loading">The server is restarting or loading today's timetable. Retrying in ${wait} s…</div>`;
    else if (!main.querySelector(".refresh-note")) main.insertAdjacentHTML("afterbegin", `<div class="callout refresh-note">The server is restarting. Showing the last data; retrying…</div>`);
    await new Promise((res) => setTimeout(res, wait * 1000));
  }
}

const CAT = { "Long distance": "#ff3d5a", InterRegio: "#ff9f1c", RegioExpress: "#2ee6a6", Regional: "#5cc8ff", "S-Bahn": "#8fa8ff", Private: "#c792ff", Panorama: "#ffd166" };
const KIND = {
  person: ["Person / accident", "#ff4d4d"], signal: ["Signal / points", "#ffb547"], power: ["Overhead line", "#ffd23f"], train: ["Train fault", "#ff7ab6"],
  infra: ["Infrastructure", "#9f8cff"], weather: ["Weather", "#5cc8ff"], police: ["Police / emergency", "#3ddc97"], other: ["Other", "#8396bf"],
};
const SEV = { 1: ["Planned", "#5a6b8c"], 2: ["Limited", "#ffb547"], 3: ["Interrupted", "#ff4d4d"] };
const CAUSE = { TECHNICAL_PROBLEM: "technical problem", ACCIDENT: "accident", WEATHER: "weather", CONSTRUCTION: "construction work", MAINTENANCE: "maintenance", POLICE_ACTIVITY: "police operation", MEDICAL_EMERGENCY: "medical emergency", STRIKE: "strike", DEMONSTRATION: "demonstration", HOLIDAY: "holiday", OTHER_CAUSE: "" };
const kindColor = { domain: Object.keys(KIND), range: Object.values(KIND).map((k) => k[1]), tickFormat: (k) => KIND[k]?.[0] ?? k };
const delayColor = (sec) => (sec >= 600 ? "#ff4d4d" : sec >= 180 ? "#ffd23f" : "#3ddc97");

// ---------- building blocks ----------
const badge = (line) => `<span class="badge" style="background:${lineColor(line)}">${esc(line)}</span>`; // same colour as on the map
const kpi = (label, value, note = "", cls = "") => `<div class="kpi ${cls}"><div class="label">${label}</div><div class="value">${value}</div>${note ? `<div class="note">${note}</div>` : ""}</div>`;
const card = (title, hint, body, w = 6) => `<section class="card w${w}"><h2>${title}</h2>${hint ? `<p class="hint">${hint}</p>` : ""}${body}</section>`;
const ch = (id) => `<div class="chart" id="${id}"></div>`;
const grade = (p) => (p == null ? "" : p >= 90 ? "good" : p < 75 ? "bad" : ""); // KPI colour for a punctuality %
const pctv = (p) => (p == null ? "–" : `${p}<small>%</small>`);
const kindChip = (k) => `<span class="kind-chip" style="--c:${KIND[k]?.[1] ?? "#8396bf"}">${esc(KIND[k]?.[0] ?? k)}</span>`;
const sevChip = (s) => `<span class="kind-chip" style="--c:${SEV[s][1]}">${SEV[s][0]}</span>`;
const empty = (text) => `<p class="hint">${text}</p>`;
function table(cols, rows, emptyText = "Nothing yet.") {
  if (!rows.length) return empty(emptyText);
  return `<div class="tbl-wrap"><table class="tbl"><thead><tr>${cols.map((c) => `<th class="${c.num ? "num" : ""}">${c.h}</th>`).join("")}</tr></thead><tbody>${rows.map((r) =>
    `<tr${r._href ? ` class="link" tabindex="0" data-href="${esc(r._href)}"` : ""}>${cols.map((c) => `<td class="${c.num ? "num" : ""}">${c.f(r)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}
main.addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-href]");
  if (tr && !e.target.closest("a")) location.href = tr.dataset.href;
});
main.addEventListener("keydown", (e) => { // rows are links for the keyboard too (they get tabindex)
  const tr = e.target.closest?.("tr[data-href]");
  if (tr && e.key === "Enter") location.href = tr.dataset.href;
});

/** Plot with the map's dark theme, sized to its container. Wide left margins (long labels) shrink on phones. */
function draw(id, opts) {
  const el = document.getElementById(id);
  if (!el) return;
  const width = el.clientWidth || 600, narrow = width < 520;
  el.replaceChildren(Plot.plot({
    width, height: narrow ? 200 : 220, marginLeft: 44,
    style: { background: "transparent", color: "#8396bf", fontFamily: "Inter, system-ui, sans-serif", fontSize: "11px" },
    ...opts,
    ...(narrow && opts.marginLeft > 90 && { marginLeft: 90 }),
  }));
}
const short = (n) => (s) => (String(s).length > n ? String(s).slice(0, n - 1) + "…" : s);
let chPromise;
const switzerland = () => (chPromise ??= fetch("switzerland.geojson").then((r) => r.json()));

// ---------- router ----------
let timers = [], nav = 0;
const routes = [
  [/^#?\/?$/, "overview", overview], [/^#\/fleet$/, "fleet", fleetPage], [/^#\/incidents$/, "incidents", incidentsPage],
  [/^#\/train\/(.+)$/, "", trainPage], [/^#\/vehicle\/(.+)$/, "fleet", vehiclePage], [/^#\/station\/(.+)$/, "", stationPage], [/^#\/line\/(.+)$/, "", linePage],
  [/^#\/types$/, "types", typesPage], [/^#\/type\/(\d{3})$/, "types", typePage], [/^#\/history$/, "history", historyPage],
];
async function route(keepScroll = false) {
  timers.forEach(clearInterval);
  timers = [];
  const token = ++nav, h = location.hash || "#/";
  for (const [re, tab, fn] of routes) {
    const m = h.match(re);
    if (!m) continue;
    for (const a of document.querySelectorAll("[data-nav]")) a.dataset.nav === tab ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current");
    if (!keepScroll) main.innerHTML = `<div class="loading">Loading…</div>`;
    try {
      await fn(...m.slice(1).map(decodeURIComponent), () => token === nav); // pages check `current()` before writing
    } catch (e) {
      if (token !== nav) return; // the user moved on meanwhile
      if (keepScroll && main.querySelector(".kpis")) { // a background refresh failed: keep the page, say so, try again later
        main.querySelector(".refresh-note")?.remove();
        main.insertAdjacentHTML("afterbegin", `<div class="callout refresh-note">Couldn't refresh (${esc(e.message)}). Showing the last data; trying again in 30 s.</div>`);
        timers.push(setInterval(() => route(true), 30000));
      } else main.innerHTML = `<div class="empty-page">Couldn't load this page: ${esc(e.message)}.<br><button class="retry" onclick="location.reload()">Try again</button></div>`;
    }
    if (!keepScroll && token === nav) scrollTo(0, 0);
    return;
  }
  main.innerHTML = `<div class="empty-page">Unknown page. <a href="#/">Back to the overview</a></div>`;
}
addEventListener("hashchange", () => route());
let lastW = innerWidth;
addEventListener("resize", () => { if (Math.abs(innerWidth - lastW) > 80) { lastW = innerWidth; route(true); } });
route();

// ---------- overview ----------
async function overview(current) {
  const o = await api("overview");
  if (!current()) return;
  const L = o.live, T = o.today, F = o.facts, H = o.history;
  document.title = "TrainNet — Stats";
  const finished = (T.observed ?? 0) - (T.cancelled ?? 0);
  main.innerHTML = `
  <div class="page-head"><div><h1>Swiss rail, today</h1><p class="sub">${day(o.date)} · <span class="live-dot"></span>live, updated ${time(Date.now() / 1000)}, refreshes every 30 s</p></div></div>
  <div class="kpis">
    ${kpi("Running now", n0(L.running), `${n0(L.late)} at least 3 min late`)}
    ${kpi("On time now", pctv(L.punctual), `running trains with live data (${n0(L.observed)}) < 3 min late`, grade(L.punctual))}
    ${kpi("Train-km today", `<span id="km">${n0(L.km)}</span>`, `the network is doing ${n0(L.kmRate * 3600)} km/h`)}
    ${kpi("Punctuality today", pctv(T.punctualPct), (finished > 0 ? `${n0(finished)} finished trains with live data · ${n0(T.cancelled)} cancelled` : "fills in as trains finish")
      + (o.typical ? `<br>a typical ${o.typical.weekday}: ${o.typical.pct} % (official data, last ${o.typical.days} weeks)` : ""), grade(T.punctualPct))}
    ${kpi("Incidents now", L.incidents, `reported in the last hour${L.stuck ? ` · ${L.stuck} train${L.stuck === 1 ? "" : "s"} probably standing (inferred)` : ""}`, L.incidents ? "alarm" : "")}
    ${kpi("Disruptions", L.alerts[2] + L.alerts[1], `${L.alerts[2]} interrupted · ${L.alerts[1]} limited · ${L.alerts[0]} planned`)}
  </div>
  <div class="grid">
    ${card("Trains on the move", "Running trains through the day; amber = at least 3 min late", ch("c-running"), 8)}
    ${card("Delay right now", "Running trains by delay at their next stop, minutes", ch("c-hist"), 4)}
    ${card("On time through the day", "Share of running trains less than 3 min late", ch("c-punct"), 8)}
    ${card("Running now by category", "", ch("c-cat"), 4)}
    ${card("Finished trains by category", "Arrived less than 3 min late at the final stop", finished > 0 ? ch("c-cat-today") : empty("Fills in as trains finish."), 4)}
    ${card("By operator", "Punctuality of finished trains", finished > 0 ? ch("c-ops") : empty("Fills in as trains finish."), 4)}
    ${card("By hour of arrival", "Punctuality of finished trains", finished > 0 ? ch("c-hour") : empty("Fills in as trains finish."), 4)}
    ${card("Where delays grow", "Sections where trains lose the most time today: arrival delay minus departure delay, averaged", ch("c-hot") + table([
      { h: "Section", f: (r) => `<a href="#/station/${r.a.uic}">${esc(r.a.name)}</a> → <a href="#/station/${r.b.uic}">${esc(r.b.name)}</a>` }, { h: "Trains", num: 1, f: (r) => r.n },
      { h: "Lost", num: 1, f: (r) => `<span style="color:${delayColor(r.gain)}">${mins(r.gain)}</span>` },
    ], T.hotspots.slice(0, 6), ""), 7)}
    ${card("Worst delays today", "Final arrival", table([
      { h: "Arrived", f: (r) => time(r.arr) }, { h: "Train", f: (r) => `${badge(r.line)} ${esc(r.train_no)}` }, { h: "Route", f: (r) => `<span class="muted">${esc(r.origin)} → ${esc(r.dest)}</span>` },
      { h: "Delay", num: 1, f: (r) => `<span style="color:${delayColor(r.final_delay)}">${mins(r.final_delay)}</span>` },
    ], T.worst.map((r) => ({ ...r, _href: `#/train/${r.train_no}` })), "No finished trains with live data yet."), 5)}
    ${card("Lines today", "Finished trains less than 3 min late at their final stop (lines with at least 4)", T.byLine.length ? table([
      { h: "Line", f: (r) => badge(r.line) }, { h: "Trains", num: 1, f: (r) => n0(r.trips) }, { h: "On time", num: 1, f: (r) => `<span style="color:${r.pct >= 90 ? "#3ddc97" : r.pct >= 75 ? "#ffd23f" : "#ff4d4d"}">${pctv(r.pct)}</span>` },
    ], [...T.byLine].sort((a, b) => a.pct - b.pct).slice(0, 12).map((r) => ({ ...r, _href: `#/line/${encodeURIComponent(r.line)}` }))) : empty("Fills in as trains finish."), 6)}
    ${card("Stations where trains leave latest", "Average departure delay today (at least 30 departures)", table([
      { h: "Station", f: (r) => esc(r.name) }, { h: "Departures", num: 1, f: (r) => n0(r.n) }, { h: "Avg delay", num: 1, f: (r) => `<span style="color:${delayColor(r.avg)}">${mins(r.avg)}</span>` },
    ], T.stationsLate.map((r) => ({ ...r, _href: `#/station/${r.uic}` })), "Fills in as trains finish."), 6)}
    ${card("Cancellations by line", "Trains cancelled today", T.cancelledByLine.length ? ch("c-canc") : empty("No cancellations recorded today."), 6)}
    ${card("Disruptions today", "Interruptions and restrictions, from first report to resolution · click a row to see it on the map", T.incidents.length ? ch("c-inc") + incidentTable(T.incidents) : empty("None so far."), 12)}
  </div>

  <h2 class="section-title">Timetable facts · today</h2>
  <div class="kpis">
    ${kpi("Trains today", n0(F.trips), "stopping in Switzerland")}
    ${kpi("Scheduled train-km", n0(F.km), "along our track geometry")}
    ${kpi("Stations served", n0(F.stations))}
    ${kpi("Operators", n0(F.operators))}
    ${kpi("First / last departure", `${F.first}<small> / ${F.last}</small>`)}
    ${kpi("Night trains", n0(F.night), "departing 01:00–04:00 or NJ/EN")}
  </div>
  <div class="grid">
    ${card("Fastest scheduled sections", "Track length over scheduled running time, Swiss sections ≥ 8 km", table([
      { h: "Section", f: (r) => `${esc(r.from)} → ${esc(r.to)}` }, { h: "Train", f: (r) => `<span class="muted">${esc(r.train)}</span>` },
      { h: "km", num: 1, f: (r) => r.km }, { h: "min", num: 1, f: (r) => r.minutes }, { h: "km/h", num: 1, f: (r) => `<b>${r.kmh}</b>` },
    ], F.fastest), 6)}
    ${card("Busiest stations", "Train calls today", table([{ h: "Station", f: (r) => esc(r.name) }, { h: "Trains", num: 1, f: (r) => n0(r.n) }],
      F.busiestStations.map((r) => ({ ...r, _href: `#/station/${r.uic}` }))), 3)}
    ${card("Busiest sections", "Trains between two stops", table([{ h: "Section", f: (r) => `${esc(r.from)} – ${esc(r.to)}` }, { h: "Trains", num: 1, f: (r) => n0(r.n) }], F.busiestSegments), 3)}
    ${card("Longest journeys", "", table([
      { h: "Train", f: (r) => esc(r.train) }, { h: "Route", f: (r) => `<span class="muted">${esc(r.from)} → ${esc(r.to)}</span>` },
      { h: "km", num: 1, f: (r) => n0(r.km) }, { h: "hours", num: 1, f: (r) => r.hours },
    ], F.longestTrips.map((r) => ({ ...r, _href: `#/train/${r.num}` }))), 6)}
    ${card("Longest non-stop runs", "", table([{ h: "Section", f: (r) => `${esc(r.from)} – ${esc(r.to)}` }, { h: "km", num: 1, f: (r) => n0(r.km) }], F.longestNonstop), 3)}
    ${card("Most platforms in use", "", table([{ h: "Station", f: (r) => esc(r.name) }, { h: "Platforms", num: 1, f: (r) => r.n }],
      F.mostPlatforms.map((r) => ({ ...r, _href: `#/station/${r.uic}` }))), 3)}
  </div>

  <h2 class="section-title">Crowding forecast · today</h2>
  <div class="grid">
    ${card("Most crowded trains", "Sections forecast standing room only / few seats left, 2nd class", table([
      { h: "Train", f: (r) => `${badge(r.line)} ${esc(r.num)}` }, { h: "Standing", num: 1, f: (r) => r.full }, { h: "Few seats", num: 1, f: (r) => r.busy }, { h: "Sections", num: 1, f: (r) => r.sections },
    ], o.crowding.mostCrowded.map((r) => ({ ...r, _href: `#/train/${r.num}` })), "No forecast loaded."), 6)}
    ${card("Crowding by hour", "Average forecast level, 2nd class: 1 many seats · 2 few seats · 3 standing", ch("c-crowd"), 6)}
  </div>

  <h2 class="section-title">History</h2>
  ${H.days.length < 2 ? `<div class="callout">History builds up one day at a time: daily punctuality, the weekday × hour heatmap and weekly disruption counts fill in as days are recorded${H.days[0] ? ` (first complete day: ${esc(H.days[0].date)})` : ""}.</div>` : ""}
  <div class="grid">
    ${card("Daily punctuality", "Finished trains less than 3 min late; the line is the 90th-percentile final delay", H.days.length ? ch("c-days") : empty("No complete day recorded yet."), 6)}
    ${card("When trains run late", "Average departure delay by weekday and hour, last 30 days", H.heat.length ? ch("c-heat") : empty("Fills in as trains finish."), 6)}
    ${card("Disruptions per week", "Interruptions and restrictions by kind", H.incidentsByWeek.length ? ch("c-week") : empty("Nothing recorded yet."), 12)}
  </div>`;

  // punctuality = late of the running trains with live data; samples from before that column existed fall back to the old ratio
  const S = o.series.map((s) => ({ ...s, date: new Date(s.t * 1000), pct: s.observed ? 100 * (1 - s.late / s.observed) : s.running ? (100 * (s.running - s.late - s.cancelled)) / s.running : null }));
  const tx = { type: "time", tickFormat: hm, label: null };
  draw("c-running", { x: tx, y: { grid: true, label: null }, marks: [
    Plot.areaY(S, { x: "date", y: "running", fill: "#2b56b0", fillOpacity: 0.35 }), Plot.lineY(S, { x: "date", y: "running", stroke: "#5cc8ff" }),
    Plot.areaY(S, { x: "date", y: "late", fill: "#ffd23f", fillOpacity: 0.45 }), Plot.ruleY([0]), Plot.tip(S, Plot.pointerX({ x: "date", y: "running", title: (d) => `${time(d.t)}\n${d.running} running · ${d.late} late · ${d.cancelled} cancelled` })),
  ] });
  draw("c-hist", { x: { label: null, domain: L.delayHist.map((d) => d.bucket) }, y: { grid: true, label: null }, marks: [
    Plot.barY(L.delayHist, { x: "bucket", y: "n", fill: (d, i) => ["#3ddc97", "#3ddc97", "#ffd23f", "#ffb547", "#ff7a4d", "#ff4d4d", "#ff4d4d"][i], tip: true }), Plot.ruleY([0]),
  ] });
  draw("c-punct", { x: tx, y: { grid: true, label: "%", domain: [Math.min(80, d3.min(S, (d) => d.pct) ?? 80), 100] }, marks: [
    Plot.lineY(S, { x: "date", y: "pct", stroke: "#3ddc97", strokeWidth: 1.6 }), Plot.tip(S, Plot.pointerX({ x: "date", y: "pct", title: (d) => `${time(d.t)}: ${d.pct?.toFixed(1)} % on time` })),
  ] });
  draw("c-cat", { marginLeft: 100, x: { grid: true, label: null }, y: { label: null }, marks: [Plot.barX(L.byCat, { y: "cat", x: "n", fill: (d) => CAT[d.cat], sort: { y: "-x" }, tip: true })] });
  draw("c-cat-today", { marginLeft: 100, x: { domain: [0, 100], grid: true, label: "%" }, y: { label: null }, marks: [Plot.barX(T.byCat.filter((d) => d.pct != null), { y: "cat", x: "pct", fill: (d) => CAT[d.cat], sort: { y: "-x" }, tip: true })] });
  draw("c-ops", { marginLeft: 150, x: { domain: [0, 100], grid: true, label: "%" }, y: { label: null, tickFormat: short(22) }, marks: [Plot.barX(T.byOperator.filter((d) => d.pct != null), { y: "name", x: "pct", fill: "#5cc8ff", sort: { y: "-x" }, tip: true })] });
  draw("c-hour", { x: { label: "hour", domain: [0, 24] }, y: { grid: true, label: "%", domain: [Math.min(80, d3.min(T.byHour, (d) => d.pct) ?? 80), 100] }, marks: [
    Plot.lineY(T.byHour, { x: "hour", y: "pct", stroke: "#3ddc97", curve: "monotone-x" }), Plot.dot(T.byHour, { x: "hour", y: "pct", fill: "#3ddc97", r: 2.5, tip: true }),
  ] });
  if (T.cancelledByLine.length) draw("c-canc", { marginLeft: 60, x: { grid: true, label: null }, y: { label: null }, marks: [Plot.barX(T.cancelledByLine, { y: "line", x: "n", fill: "#ff4d4d", sort: { y: "-x" }, tip: true })] });
  if (T.incidents.length) incidentGantt("c-inc", T.incidents);
  draw("c-crowd", { x: { label: "hour", domain: [0, 24] }, y: { domain: [1, 3], grid: true, label: null }, marks: [Plot.areaY(o.crowding.byHour, { x: "hour", y1: 1, y2: "level", fill: "#ffb547", fillOpacity: 0.25, curve: "monotone-x" }), Plot.lineY(o.crowding.byHour, { x: "hour", y: "level", stroke: "#ffb547", curve: "monotone-x", tip: true })] });
  if (H.days.length) draw("c-days", { x: { type: "band", label: null, tickFormat: (d) => d.slice(5) }, y: { grid: true, label: "%", domain: [Math.min(80, d3.min(H.days, (d) => d.pct) ?? 80), 100] }, marks: [
    Plot.barY(H.days, { x: "date", y: "pct", fill: "#3ddc97", tip: true, title: (d) => `${d.date}: ${d.pct} % on time\n${n0(d.observed)} trains with live data · ${n0(d.cancelled)} cancelled\naverage final delay ${mins(d.avg_delay)} · 90th percentile ${mins(d.p90_delay)}` }),
  ] });
  if (H.heat.length) draw("c-heat", { height: 230, marginLeft: 40, x: { label: "hour", domain: d3.range(24) }, y: { label: null, domain: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] },
    color: { scheme: "YlOrRd", legend: true, label: "avg delay, min" }, marks: [Plot.cell(H.heat, { x: "hour", y: "dow", fill: "avg", inset: 1, tip: true })] });
  if (H.incidentsByWeek.length) draw("c-week", { x: { label: "week of", type: "band" }, y: { grid: true, label: null }, color: { ...kindColor, legend: true }, marks: [Plot.barY(H.incidentsByWeek, { x: "week", y: "n", fill: "kind", tip: true })] });
  hotspotMap("c-hot", T.hotspots);

  // live km counter, and a full refresh every 30 s while this page is open
  let km = L.km, t0 = Date.now();
  timers.push(setInterval(() => { const el = document.getElementById("km"); if (el) el.textContent = n0(km + (L.kmRate * (Date.now() - t0)) / 1000); }, 250));
  timers.push(setInterval(() => route(true), 30000));
}

async function hotspotMap(id, rows) {
  const el = document.getElementById(id);
  if (!el) return;
  const outline = await switzerland();
  const lines = rows.map((r) => ({ ...r, gainMin: r.gain / 60 }));
  const w = el.clientWidth || 600;
  el.replaceChildren(Plot.plot({
    width: w, height: Math.round(w * 0.62), projection: { type: "mercator", domain: outline, inset: 10 },
    style: { background: "transparent", color: "#8396bf", fontFamily: "Inter, system-ui, sans-serif", fontSize: "11px" },
    color: { type: "linear", scheme: "YlOrRd", domain: [0, Math.max(2, d3.max(lines, (d) => d.gainMin) ?? 2)], legend: true, label: "minutes lost on the section" },
    marks: [
      Plot.geo(outline, { fill: "#0b1a3d", stroke: "#3a6fd8", strokeOpacity: 0.7 }),
      Plot.link(lines, { x1: (d) => d.a.lon, y1: (d) => d.a.lat, x2: (d) => d.b.lon, y2: (d) => d.b.lat, stroke: "gainMin", strokeWidth: 3.5, strokeLinecap: "round" }),
      Plot.tip(lines, Plot.pointer({ x: (d) => (d.a.lon + d.b.lon) / 2, y: (d) => (d.a.lat + d.b.lat) / 2, title: (d) => `${d.a.name} → ${d.b.name}\n+${d.gainMin.toFixed(1)} min on average · ${d.n} trains` })),
    ],
  }));
  if (!rows.length) el.insertAdjacentHTML("beforeend", empty("Fills in as trains finish."));
}

const duration = (sec) => (sec >= 86400 ? `${n0(sec / 86400)} d` : sec >= 5400 ? `${n0(sec / 3600)} h` : `${n0(sec / 60)} min`);
function incidentTable(rows) {
  return table([
    { h: "Since", f: (r) => when(r.since ?? r.first_seen) }, { h: "", f: (r) => sevChip(r.sev_max) }, { h: "Kind", f: (r) => kindChip(r.kind) },
    { h: "What", f: (r) => `${r.sudden ? "⚡ " : ""}${esc(r.h)}<br><span class="muted">${esc(r.why)}</span>` },
    { h: "Duration", num: 1, f: (r) => duration(r.last_seen - (r.since ?? r.first_seen)) },
  ], rows.map((r) => ({ ...r, _href: Date.now() / 1000 - r.last_seen < 600 ? `/?alert=${encodeURIComponent(r.id)}` : undefined }))); // still reported: show it on the map
}
function incidentGantt(id, rows) {
  const now = Date.now() / 1000;
  const data = rows.map((r) => ({ ...r, start: new Date((r.since ?? r.first_seen) * 1000), end: new Date((now - r.last_seen < 180 ? now : r.last_seen) * 1000), label: short(46)(r.h) }));
  draw(id, { height: Math.max(80, 26 * data.length + 40), marginLeft: 290, x: { type: "time", tickFormat: hm, label: null, grid: true }, y: { label: null }, color: kindColor,
    marks: [Plot.barX(data, { x1: "start", x2: "end", y: "label", fill: "kind", rx: 3, tip: true, title: (d) => `${d.h}\n${d.why}\n${time(d.since ?? d.first_seen)}–${time(d.last_seen)}` })] });
}

// ---------- train ----------
async function trainPage(num, current) {
  const t = await api(`train/${encodeURIComponent(num)}`, true);
  if (!current()) return;
  const run = t?.runs[0];
  if (!t || (!run && !t.history.length)) { main.innerHTML = `<div class="empty-page">No train ${esc(num)} today and nothing recorded for it.</div>`; return; }
  document.title = `TrainNet — ${run ? run.line : ""} ${num}`;
  const unitsDate = t.vehicles[0]?.date, unitsToday = t.vehicles.filter((v) => v.date === unitsDate), unitsOld = unitsDate && unitsDate !== todayZH();
  const stops = run?.stops ?? [], cur = run?.at == null ? null : stops[Math.ceil(run.at)];
  const finished = t.history.filter((h) => h.observed && !h.cancelled), ok = finished.filter((h) => h.final_delay < 180).length;
  const status = !run ? "not running today" : run.cancelled ? "cancelled" : run.running ? `running · ${mins(cur?.delay)} at ${esc(cur?.name)}` : run.stops.at(-1).arr * 1000 < Date.now() ? `arrived ${mins(stops.at(-1).delay)}` : `departs ${time(stops[0].dep)}`;
  main.innerHTML = `
  <div class="page-head"><div><h1>${run ? badge(run.line, run.cat) : ""} ${esc(num)}</h1>
    <p class="sub">${run ? `${esc(run.operator)} · ${esc(stops[0].name)} → ${esc(stops.at(-1).name)} · ${status}` : "not running today"}</p></div>
    <div class="actions">${run ? `<a href="/?train=${encodeURIComponent(num)}">Show on map →</a>` : ""}</div></div>
  ${run?.stuckSince ? `<div class="callout quiet">Probably standing: its expected delay at the next stop has been rising since ${time(run.stuckSince)}. An inference from the forecasts, not a report.</div>` : ""}
  <div class="kpis">
    ${kpi("Now", run?.running ? mins(cur?.delay) : "–", run?.running ? `at ${esc(cur?.name)}` : "")}
    ${kpi("Distance", run ? `${n0(stops.at(-1).km)}<small> km</small>` : "–", run ? `${stops.length} stops` : "")}
    ${kpi("Trainsets", unitsToday.length || "–", unitsToday.length ? esc([...new Set(unitsToday.map((u) => u.type))].join(", ")) + (unitsOld ? ` · as on ${esc(unitsDate)}` : "") : "long-distance trains only")}
    ${kpi("Days recorded", t.history.length + t.older.length)}
    ${kpi("Punctual", finished.length ? pctv(Math.round((1000 * ok) / finished.length) / 10) : "–", finished.length ? `${ok} of ${finished.length} recorded runs` : "no finished run recorded yet")}
    ${kpi("Average final delay", finished.length ? mins(d3.mean(finished, (h) => h.final_delay)) : "–", finished.length ? `worst ${mins(d3.max(finished, (h) => h.max_delay))} on the way` : "")}
    ${kpi("Probably standing", finished.length ? `${n0(d3.sum(t.history, (h) => h.stuck_min))}<small> min</small>` : "–", "inferred, all recorded days")}
  </div>
  <div class="grid">
    ${card("Today's run", "Delay at each stop (live forecast for the stops ahead)", stops.length ? ch("c-run") : empty("Not running today."), 8)}
    ${card("Trainsets", unitsOld ? `The physical units on ${esc(unitsDate)}: today's aren't recorded yet` : "The physical units running this train", unitsToday.length ? `<div class="units">${unitsToday.map((u) => `<a class="unit-chip" href="#/vehicle/${u.unit}">${esc(u.type)} <b>${esc(u.unit)}</b><small>${n0(u.km)} km</small></a>`).join("")}</div>` : empty("Not recorded: formations are crawled for long-distance trains once a day."), 4)}
    ${card("Crowding forecast", "2nd class per section: 1 many seats · 2 few seats · 3 standing", t.crowding.length ? ch("c-crowd") : empty("No forecast for this train."), 6)}
    ${card("Every day", "Final delay per recorded day", t.history.length ? ch("c-days") : empty("History starts with the first finished run."), 6)}
    ${card("Where it usually loses time", "Average arrival delay per stop across recorded days", t.profile.length ? ch("c-prof") : empty("Fills in as runs finish."), 12)}
    ${sinceCard(t.since, `Train ${esc(num)}`)}
    ${card("Stops", "", table([
      { h: "Time", f: (s) => time(s.dep || s.arr) }, { h: "Station", f: (s) => esc(s.name) }, { h: "Pl.", f: (s) => esc(s.platform ?? "") },
      { h: "km", num: 1, f: (s) => n0(s.km) }, { h: "Delay", num: 1, f: (s) => (s.skipped ? `<span style="color:#ff4d4d">skipped</span>` : `<span style="color:${delayColor(s.delay)}">${mins(s.delay)}</span>`) },
    ], stops.map((s) => ({ ...s, _href: `#/station/${s.uic}` }))), 6)}
    ${card("Trainsets by day", "", table([
      { h: "Date", f: (v) => esc(v.date) }, { h: "Unit", f: (v) => `<a href="#/vehicle/${v.unit}">${esc(v.type)} ${esc(v.unit)}</a>` }, { h: "km", num: 1, f: (v) => n0(v.km) },
    ], t.vehicles, "Not recorded yet."), 6)}
  </div>`;
  // keyed by position: a train can call at the same station twice
  const sx = (s, k) => `${k}·${s.name}`, label = (v) => short(18)(v.split("·")[1]);
  if (stops.length) draw("c-run", { height: 260, marginBottom: 90, x: { type: "point", domain: stops.map(sx), tickRotate: -40, label: null, tickFormat: label }, y: { grid: true, label: "min" }, marks: [
    Plot.ruleY([0, 3], { stroke: "#ffd23f", strokeOpacity: 0.25 }), Plot.lineY(stops, { x: sx, y: (s) => s.delay / 60, stroke: "#5cc8ff", curve: "monotone-x" }),
    Plot.dot(stops, { x: sx, y: (s) => s.delay / 60, fill: (s) => delayColor(s.delay), r: 3.5, tip: true, title: (s) => `${s.name}\n${time(s.dep || s.arr)} · ${mins(s.delay)}` }),
  ] });
  if (t.crowding.length) draw("c-crowd", { x: { label: null, tickRotate: -40, type: "band" }, y: { domain: [0, 3], label: null, grid: true }, marginBottom: 50, marks: [Plot.barY(t.crowding, { x: (s) => s[0].slice(0, 5), y: (s) => s[2], fill: (s) => ["#2a3f6b", "#3ddc97", "#ffd23f", "#ff4d4d"][s[2]], tip: true })] });
  if (t.history.length) {
    const seen = t.history.filter((h) => h.observed);
    draw("c-days", { x: { type: "band", label: null, tickFormat: (d) => d.slice(5) }, y: { grid: true, label: "min" }, marks: [
      Plot.barY(seen.filter((h) => !h.cancelled), { x: "date", y: (h) => h.final_delay / 60, fill: (h) => delayColor(h.final_delay), tip: true, title: (h) => `${h.date}: ${mins(h.final_delay)} at the end, worst ${mins(h.max_delay)}` }),
      Plot.dot(seen.filter((h) => h.cancelled), { x: "date", y: 0, symbol: "times", stroke: "#ff4d4d", strokeWidth: 2, r: 5, tip: true, title: (h) => `${h.date}: cancelled` }), // a cancelled day has no delay bar
      Plot.ruleY([0]),
    ] });
  }
  drawSince(t.since);
  if (t.profile.length) draw("c-prof", { height: 240, marginBottom: 90, x: { type: "point", domain: t.profile.map((p) => `${p.idx}·${p.name}`), tickRotate: -40, tickFormat: (s) => short(18)(s.split("·")[1]), label: null }, y: { grid: true, label: "min" }, marks: [
    Plot.areaY(t.profile, { x: (p) => `${p.idx}·${p.name}`, y: (p) => (p.arr ?? 0) / 60, fill: "#ffb547", fillOpacity: 0.2 }),
    Plot.lineY(t.profile, { x: (p) => `${p.idx}·${p.name}`, y: (p) => (p.arr ?? 0) / 60, stroke: "#ffb547", tip: true, title: (p) => `${p.name}: ${mins(p.arr)} on average over ${p.n} runs` }),
  ] });
}

// ---------- vehicle ----------
async function vehiclePage(unit, current) {
  const v = await api(`vehicle/${encodeURIComponent(unit)}`, true);
  if (!current()) return;
  if (!v?.spec) { main.innerHTML = `<div class="empty-page">No runs recorded for ${esc(unit)} yet. Trainsets are recorded from the daily crawl of long-distance formations.</div>`; return; }
  document.title = `TrainNet — ${v.spec.type} ${unit}`;
  const km = d3.sum(v.runs, (r) => r.km), now = v.now;
  const reg = v.register, age = reg?.built ? Math.floor((Date.now() - Date.parse(reg.built)) / (365.25 * 86400_000)) : null;
  main.innerHTML = `
  <div class="page-head"><div><h1><a class="type-link" href="#/type/${esc(v.spec.class)}">${esc(v.spec.type)}</a> <span style="color:var(--muted)">${esc(unit)}</span></h1>
    <p class="sub">${reg?.subtype ? `${esc(reg.subtype)} · ` : `Class ${esc(v.spec.class)} · `}${reg?.built ? `built ${esc(reg.built)} (${age} years) · ` : ""}${v.runs.length} trains today</p></div>
    <div class="actions">${now ? `<a href="/?train=${encodeURIComponent(now.train)}">Where is it now? →</a>` : ""}</div></div>
  ${now ? `<div class="callout">Running now as ${badge(now.line, now.cat)} <b>${esc(now.train)}</b> ${esc(now.from)} → ${esc(now.to)}, ${mins(now.delay)}.</div>` : ""}
  <div class="kpis">
    ${kpi("Length", `${n0(v.spec.length_m)}<small> m</small>`)}
    ${kpi("Seats", `${n0(v.spec.seats1 + v.spec.seats2)}`, `${n0(v.spec.seats1)} 1st · ${n0(v.spec.seats2)} 2nd`)}
    ${kpi("Restaurant", v.spec.has_wr ? "Yes" : "No", reg?.wheelchair ? `${reg.wheelchair} wheelchair places` : "")}
    ${kpi("Distance today", `${n0(km)}<small> km</small>`, `${v.runs.length} trains`)}
    ${kpi("Days seen", v.history.length, v.history.length ? `${n0(d3.sum(v.history, (h) => h.km))} km recorded` : "")}
  </div>
  <div class="grid">
    ${card("Today's circulation", "Each bar is a train this unit ran", v.runs.length ? ch("c-circ") : empty("Not in service today."), 12)}
    ${card("Trains today", "", table([
      { h: "Time", f: (r) => `${time(r.dep)}–${time(r.arr)}` }, { h: "Train", f: (r) => `${badge(r.line)} ${esc(r.train)}` },
      { h: "Route", f: (r) => `<span class="muted">${esc(r.from)} → ${esc(r.to)}</span>` }, { h: "km", num: 1, f: (r) => n0(r.km) },
      { h: "", num: 1, f: (r) => (r.state === "running" ? `<b style="color:var(--accent)">running</b> ${mins(r.delay)}` : r.state === "done" ? `<span class="muted">done ${mins(r.delay)}</span>` : r.state) },
    ], v.runs.map((r) => ({ ...r, _href: `#/train/${r.train}` }))), 8)}
    ${card("Trains it ran most", "All recorded days", table([{ h: "Train", f: (r) => esc(r.train_no) }, { h: "Times", num: 1, f: (r) => r.n }], v.trains.map((r) => ({ ...r, _href: `#/train/${r.train_no}` }))), 4)}
    ${card("Distance per day", "", v.history.length > 1 ? ch("c-hist") : empty("More days will show up here."), 12)}
  </div>`;
  if (v.runs.length) {
    const runs = v.runs.map((r) => ({ ...r, x1: new Date(r.dep * 1000), x2: new Date(r.arr * 1000), mid: new Date(((r.dep + r.arr) / 2) * 1000) }));
    draw("c-circ", { height: 110, marginLeft: 10, x: { type: "time", tickFormat: hm, label: null, grid: true }, y: { axis: null }, marks: [
      Plot.barX(runs, { x1: "x1", x2: "x2", y: () => 0, fill: (r) => lineColor(r.line), fillOpacity: (r) => (r.state === "planned" ? 0.4 : 0.9), rx: 4, insetTop: 18, insetBottom: 18, tip: true, title: (r) => `${r.line} ${r.train}\n${r.from} → ${r.to}\n${time(r.dep)}–${time(r.arr)} · ${n0(r.km)} km` }),
      Plot.text(runs, { x: "mid", y: () => 0, text: (r) => r.train, fill: "#040a18", fontWeight: 600 }), Plot.ruleX([new Date()], { stroke: "#fff", strokeOpacity: 0.6 }),
    ] });
  }
  if (v.history.length > 1) draw("c-hist", { x: { type: "band", label: null, tickFormat: (d) => d.slice(5) }, y: { grid: true, label: "km" }, marks: [Plot.barY(v.history, { x: "date", y: "km", fill: "#5cc8ff", tip: true })] });
}

// ---------- fleet ----------
async function fleetPage(current) {
  const f = await api("fleet");
  if (!current()) return;
  document.title = "TrainNet — Fleet";
  main.innerHTML = `
  <div class="page-head"><div><h1>Fleet today</h1><p class="sub">The physical trainsets behind every long-distance train, from the daily formation crawl</p></div></div>
  ${f.crawled === 0 ? `<div class="callout">The formation crawl hasn't recorded anything for today yet. It runs once a day, about an hour after the timetable loads.</div>` : ""}
  <div class="kpis">
    ${kpi("Trainsets in service", n0(f.units), "and locomotives")}
    ${kpi("Types", f.byType.length)}
    ${kpi("Unit runs recorded", n0(f.crawled))}
    ${kpi("Restaurant cars running", f.restaurantsNow.length)}
  </div>
  <div class="grid">
    ${card("Trainsets by type", `Units in service today · <a href="#/types">all types →</a>`, f.byType.length ? ch("c-types") + `<div class="spot-links">${f.byType.map((t) => `<a href="#/type/${t.cls}">${esc(t.type)} <small>${t.units}</small></a>`).join("")}</div>` : empty("–"), 6)}
    ${card("Distance by type", "km run today, all units of a type", f.byType.length ? ch("c-km") : empty("–"), 6)}
    ${card("Most kilometres today", "", table([
      { h: "Unit", f: (r) => `${esc(r.type)} <b>${esc(r.unit)}</b>` }, { h: "Trains", num: 1, f: (r) => r.runs }, { h: "km", num: 1, f: (r) => n0(r.km) },
    ], f.leaderboard.map((r) => ({ ...r, _href: `#/vehicle/${r.unit}` }))), 6)}
    ${card("Longest trains today", "", table([{ h: "Train", f: (r) => esc(r.train) }, { h: "Units", f: (r) => `<span class="muted">${esc(r.units.join(" + "))}</span>` }, { h: "m", num: 1, f: (r) => n0(r.length) }], f.longest), 6)}
    ${card("Most seats", "", table([{ h: "Train", f: (r) => esc(r.train) }, { h: "Units", f: (r) => `<span class="muted">${esc(r.units.join(" + "))}</span>` }, { h: "Seats", num: 1, f: (r) => n0(r.seats) }], f.mostSeats), 6)}
    ${card("Restaurant cars running now", "", table([{ h: "Train", f: (r) => `${badge(r.line)} ${esc(r.train)}` }, { h: "Unit", f: (r) => `${esc(r.type)} ${esc(r.unit)}` }],
      f.restaurantsNow.map((r) => ({ ...r, _href: `#/train/${r.train}` })), "None right now."), 6)}
    ${card("Which trainsets run which line", "Unit runs per line today", f.mixByLine.length ? ch("c-mix") : empty("–"), 12)}
    ${card("How old the fleet in service is", "Build year of every unit running today that SBB's rolling stock register lists", f.ages.length ? ch("c-ages") : empty("No register data yet (it loads once a week)."), 8)}
    ${card("Oldest and newest today", "", f.oldest.length ? table([{ h: "Unit", f: (r) => `${esc(r.type)} <b>${esc(r.unit)}</b>` }, { h: "Built", num: 1, f: (r) => esc(r.built) }],
      [...f.oldest.slice(0, 4), ...f.newest.slice(0, 4)].map((r) => ({ ...r, _href: `#/vehicle/${r.unit}` }))) : empty("–"), 4)}
  </div>`;
  const types = f.byType.map((t) => t.type);
  const typeColor = { domain: types, range: d3.quantize(d3.interpolateRgbBasis(["#5cc8ff", "#8fa8ff", "#c792ff", "#ff7ab6", "#ff9f1c", "#ffd166", "#2ee6a6"]), Math.max(2, types.length)) };
  draw("c-types", { marginLeft: 90, x: { grid: true, label: null }, y: { label: null }, color: typeColor, marks: [Plot.barX(f.byType, { y: "type", x: "units", fill: "type", sort: { y: "-x" }, tip: true })] });
  draw("c-km", { marginLeft: 90, x: { grid: true, label: null }, y: { label: null }, color: typeColor, marks: [Plot.barX(f.byType, { y: "type", x: "km", fill: "type", sort: { y: "-x" }, tip: true })] });
  if (f.ages.length) draw("c-ages", { marginLeft: 90, x: { label: "built", tickFormat: "d", grid: true }, y: { label: null, domain: d3.groupSort(f.ages, (g) => d3.median(g, (a) => a.year), (a) => a.type) }, color: typeColor,
    marks: [Plot.dot(f.ages, { x: "year", y: "type", fill: "type", r: 3, fillOpacity: 0.7, tip: true }), Plot.tickX(f.ages, Plot.groupY({ x: "median" }, { x: "year", y: "type", stroke: "#fff", strokeWidth: 2 }))] });
  const mix = f.mixByLine.flatMap((l) => l.types.map((t) => ({ line: l.line, ...t })));
  draw("c-mix", { height: 26 * f.mixByLine.length + 50, marginLeft: 60, x: { grid: true, label: null }, y: { label: null, domain: f.mixByLine.map((l) => l.line) }, color: { ...typeColor, legend: true }, marks: [Plot.barX(mix, { y: "line", x: "n", fill: "type", tip: true })] });
}

/** Every month from the first to the last row, missing ones as gaps (pct null), so a line breaks instead of bridging them. */
function everyMonth(rows) {
  if (!rows.length) return [];
  const by = new Map(rows.map((r) => [r.month, r])), out = [];
  for (let [y, m] = rows[0].month.split("-").map(Number); `${y}-${String(m).padStart(2, "0")}` <= rows.at(-1).month; m === 12 ? (y++, (m = 1)) : m++) {
    const month = `${y}-${String(m).padStart(2, "0")}`;
    out.push({ ...(by.get(month) ?? { pct: null, perDay: null }), month, date: new Date(`${month}-15`) });
  }
  return out;
}

/** A "since 2018" card: monthly punctuality from the official actual data. */
const sinceCard = (x, what, w = 12) => card(`Since ${x ? x.from.slice(0, 4) : 2018}`, x ? `${what}, official actual data: ${pctv(x.pct)} on time over ${n0(x.n)} ${/departure/i.test(what) ? "departures" : "runs"}` : "",
  x ? ch("c-since") : empty("Not in the official history (yet): it's imported month by month."), w);
const drawSince = (x) => {
  if (!x) return;
  const M = everyMonth(x.months);
  draw("c-since", { height: 200, x: { type: "time", label: null }, y: { grid: true, label: "%", domain: [Math.min(70, d3.min(M, (m) => m.pct) ?? 70), 100] }, marks: [
    Plot.lineY(M, { x: "date", y: "pct", stroke: "#3ddc97", strokeWidth: 1.6 }),
    Plot.tip(M.filter((m) => m.pct != null), Plot.pointerX({ x: "date", y: "pct", title: (m) => `${m.month}: ${m.pct} % of ${n0(m.n)}` })),
  ] });
};

// ---------- history ----------
async function historyPage(current) {
  const h = await api("history", true); // 404 = nothing imported yet
  if (!current()) return;
  document.title = "TrainNet — History";
  if (!h) { main.innerHTML = `<div class="empty-page">The official history (actual data since 2018) is being imported. Check back in a few hours.</div>`; return; }
  const full = h.years.filter((y) => y.days >= 360), best = d3.greatest(full, (y) => y.pct), worst = d3.least(full, (y) => y.pct), last = h.months.at(-1);
  main.innerHTML = `
  <div class="page-head"><div><h1>Since ${esc(h.first.slice(0, 4))}</h1><p class="sub">Every train of every day from the official actual data (Ist-Daten): ${n0(h.days)} days, ${esc(h.first)} to ${esc(h.last)}</p></div></div>
  <div class="kpis">
    ${kpi(`On time, ${esc(last.month)}`, pctv(last.pct), `latest month imported (${last.days} days) · arrival less than 3 min late at the last stop`, grade(last.pct))}
    ${best ? kpi("Best year", esc(best.year), `${best.pct} % on time`, "good") : ""}
    ${worst ? kpi("Worst year", esc(worst.year), `${worst.pct} % on time`) : ""}
    ${kpi("Trains a day", n0(last.perDay), `in ${esc(last.month)}`)}
    ${kpi(`Cancelled, ${esc(last.month)}`, pctv(last.cancelledPct), `${n0(last.cancelled)} trains`)}
  </div>
  <div class="grid">
    ${card("Punctuality by month", "Trains arriving less than 3 min late at their last Swiss stop", ch("c-months"), 12)}
    ${card("Trains a day", "Average per month: you can see 2020", ch("c-perday"), 6)}
    ${card("Cancelled and extra trains", "Per year (the current year so far)", ch("c-years"), 6)}
    ${card("When it's worst", "Share of departures 3+ min late, by month of the year and hour", ch("c-season"), 12)}
    ${card("Lines by year", "Lines with at least 3,000 runs that year: least and most punctual", `<div class="filters"><select id="h-year" aria-label="Year">${h.lines.map((l) => `<option>${l.year}</option>`).join("")}</select></div><div id="h-lines"></div>`, 12)}
  </div>`;
  const M = everyMonth(h.months), have = M.filter((m) => m.pct != null);
  draw("c-months", { height: 260, x: { type: "time", label: null }, y: { grid: true, label: "%", domain: [Math.min(80, d3.min(M, (m) => m.pct) ?? 80), 100] }, marks: [
    Plot.areaY(M, { x: "date", y1: Math.min(80, d3.min(M, (m) => m.pct) ?? 80), y2: "pct", fill: "#3ddc97", fillOpacity: 0.12 }),
    Plot.lineY(M, { x: "date", y: "pct", stroke: "#3ddc97", strokeWidth: 1.6 }),
    Plot.tip(have, Plot.pointerX({ x: "date", y: "pct", title: (m) => `${m.month}: ${m.pct} % on time\n${n0(m.perDay)} trains a day · ${m.cancelledPct} % cancelled\naverage final delay ${mins(m.avgDelay)}` })),
  ] });
  draw("c-perday", { x: { type: "time", label: null }, y: { grid: true, label: null }, marks: [Plot.areaY(M, { x: "date", y: "perDay", fill: "#2b56b0", fillOpacity: 0.5 }), Plot.lineY(M, { x: "date", y: "perDay", stroke: "#5cc8ff" }), Plot.tip(have, Plot.pointerX({ x: "date", y: "perDay", title: (m) => `${m.month}: ${n0(m.perDay)} trains a day` }))] });
  const Y = h.years.flatMap((y) => [{ year: y.year, kind: "cancelled", n: y.cancelled }, { year: y.year, kind: "extra", n: y.extra }]);
  draw("c-years", { x: { axis: null }, fx: { label: null }, y: { grid: true, label: null }, color: { domain: ["cancelled", "extra"], range: ["#ff4d4d", "#5cc8ff"], legend: true },
    marks: [Plot.barY(Y, { x: "kind", fx: "year", y: "n", fill: "kind", tip: true }), Plot.ruleY([0])] });
  draw("c-season", { height: 300, marginLeft: 40, x: { label: "hour", domain: d3.range(24) }, y: { label: null, domain: d3.range(1, 13), tickFormat: (m) => ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1] },
    color: { scheme: "YlOrRd", legend: true, label: "% of departures 3+ min late" }, marks: [Plot.cell(h.season, { x: "hour", y: "month", fill: "late", inset: 1, tip: true })] });
  const lines = () => {
    const y = h.lines.find((l) => l.year === document.getElementById("h-year").value);
    const t = (rows) => table([{ h: "Line", f: (r) => badge(r.line) }, { h: "Runs", num: 1, f: (r) => n0(r.trips) }, { h: "On time", num: 1, f: (r) => pctv(r.pct) }], rows.map((r) => ({ ...r, _href: `#/line/${encodeURIComponent(r.line)}` })));
    document.getElementById("h-lines").innerHTML = y ? `<div class="two"><div><h3 class="mini">Least punctual</h3>${t(y.worst)}</div><div><h3 class="mini">Most punctual</h3>${t(y.best)}</div></div>` : "";
  };
  document.getElementById("h-year").addEventListener("input", lines);
  lines();
}

// ---------- train types ----------
async function typesPage(current) {
  const list = await api("types");
  if (!current()) return;
  document.title = "TrainNet — Train types";
  main.innerHTML = `
  <div class="page-head"><div><h1>Train types</h1><p class="sub">Every series we've seen in a formation or found in SBB's rolling stock register</p></div></div>
  <div class="type-grid">${list.map((t) => `<a class="type-card" href="#/type/${t.cls}">
    <div class="type-top"><b>${esc(t.name)}</b><span class="muted">series ${esc(t.cls)}</span></div>
    ${t.about ? `<p>${esc(t.about)}</p>` : ""}
    <div class="type-facts">${[t.today ? `<span><b>${t.today}</b> running today</span>` : "", t.registered ? `<span><b>${t.registered}</b> in the register</span>` : "", t.built ? `<span>built ${t.built[0] === t.built[1] ? t.built[0] : `${t.built[0]}–${t.built[1]}`}</span>` : "",
      t.seats ? `<span>${n0(t.seats)} seats</span>` : "", t.kmToday ? `<span>${n0(t.kmToday)} km today</span>` : ""].filter(Boolean).join("")}</div>
    ${t.lines.length ? `<div class="type-lines">${t.lines.map(badge).join("")}</div>` : ""}
  </a>`).join("")}</div>`;
}

async function typePage(cls, current) {
  const t = await api(`type/${cls}`, true);
  if (!current()) return;
  if (!t) { main.innerHTML = `<div class="empty-page">Nothing known about series ${esc(cls)} yet.</div>`; return; }
  document.title = `TrainNet — ${t.name}`;
  const running = t.units.filter((u) => u.runsToday), year = new Date().getFullYear();
  main.innerHTML = `
  <div class="page-head"><div><h1>${esc(t.name)} <span style="color:var(--muted)">series ${esc(t.cls)}</span></h1>
    <p class="sub">${t.about ? esc(t.about) : ""}${t.wiki ? ` <a class="inline" href="${esc(t.wiki)}" target="_blank" rel="noopener">Wikipedia ↗</a>` : ""}</p></div></div>
  <div class="kpis">
    ${kpi("In service today", n0(running.length), `of ${n0(t.units.length)} units known`)}
    ${kpi("Distance today", `${n0(d3.sum(running, (u) => u.kmToday))}<small> km</small>`, running.length ? `${n0(d3.mean(running, (u) => u.kmToday))} km per unit` : "")}
    ${kpi("Recorded in total", `${n0(d3.sum(t.units, (u) => u.kmTotal))}<small> km</small>`, "since we started recording")}
    ${kpi("Built", t.years.length ? `${d3.min(t.years)}${d3.max(t.years) !== d3.min(t.years) ? `<small>–${d3.max(t.years)}</small>` : ""}` : "–", t.years.length ? `average age ${n0(year - d3.mean(t.years))} years` : "not in SBB's register")}
  </div>
  <div class="grid">
    ${card("Lines today", "Train runs per line", t.lines.length ? table([{ h: "Line", f: (r) => badge(r.line) }, { h: "Runs", num: 1, f: (r) => r.n }], t.lines.slice(0, 12).map((r) => ({ ...r, _href: `#/line/${encodeURIComponent(r.line)}` }))) : empty("Not seen running today."), 4)}
    ${card("Build years", "Units in SBB's rolling stock register", t.years.length ? ch("c-years") : empty("This series isn't in SBB's register."), 8)}
    ${card("Units", "Today first, then by distance recorded", table([
      { h: "Unit", f: (u) => `<b>${esc(u.unit)}</b>${u.subtype ? ` <span class="muted">${esc(u.subtype)}</span>` : ""}` }, { h: "Built", f: (u) => esc(u.built ?? "–") },
      { h: "Today", num: 1, f: (u) => (u.runsToday ? `${u.runsToday} trains · ${n0(u.kmToday)} km` : "–") }, { h: "Recorded", num: 1, f: (u) => (u.kmTotal ? `${n0(u.kmTotal)} km` : "–") },
    ], t.units.slice(0, 200).map((u) => ({ ...u, _href: u.kmTotal || u.runsToday ? `#/vehicle/${u.unit}` : undefined }))), 12)}
  </div>`;
  if (t.years.length) draw("c-years", { x: { label: "built", tickFormat: "d" }, y: { grid: true, label: "units" }, marks: [Plot.rectY(t.years, Plot.binX({ y: "count" }, { x: (y) => y, interval: 1, fill: "#5cc8ff", tip: true })), Plot.ruleY([0])] });
}

// ---------- station ----------
async function stationPage(uic, current) {
  const s = await api(`station/${encodeURIComponent(uic)}`, true);
  if (!current()) return;
  if (!s) { main.innerHTML = `<div class="empty-page">Unknown station.</div>`; return; }
  document.title = `TrainNet — ${s.name}`;
  main.innerHTML = `
  <div class="page-head"><div><h1>${esc(s.name)}</h1><p class="sub">${n0(s.trips)} train calls today${s.pax ? ` · ≈ ${n0(s.pax.daily)} passengers a day (${s.pax.year}, SBB count)` : ""} · UIC ${esc(s.uic)}</p></div>
    <div class="actions"><a href="/?station=${encodeURIComponent(s.uic)}">Departures on the map →</a></div></div>
  <div class="kpis">
    ${kpi("Departures on time today", pctv(s.today.pct), s.today.n ? `${n0(s.today.n)} departures recorded` : "fills in as trains leave")}
    ${kpi("Avg departure delay today", mins(s.today.avg))}
    ${kpi("Departures on time, 30 days", pctv(s.month.pct), s.month.n ? `${n0(s.month.n)} departures` : "")}
    ${kpi("Arrivals on time, 30 days", pctv(s.month.arrPct))}
    ${kpi("Delay hand-over", s.month.n ? `${mins(s.month.arr)}<small> → ${mins(s.month.avg)}</small>` : "–", "average arriving → departing delay")}
  </div>
  <div class="grid">
    ${card("Departures per hour", "Bars: today's timetable · line: typical recorded day", ch("c-hour"), 8)}
    ${card("Platforms", "Departures per platform today", s.platforms.length ? ch("c-plat") : empty("–"), 4)}
    ${card("Lines", "Departures per line today", table([{ h: "Line", f: (r) => badge(r.line) }, { h: "Departures", num: 1, f: (r) => r.n }], s.lines.map((r) => ({ ...r, _href: `#/line/${encodeURIComponent(r.line)}` }))), 4)}
    ${card("Daily punctuality", "Departures less than 3 min late; hover for the average departure delay", s.daily.length ? ch("c-days") : empty("History builds up day by day."), 8)}
    ${sinceCard(s.since, "Departures here")}
    ${card("Disruptions here", "Last 30 days", incidentTable(s.incidents.map((r) => ({ ...r, sudden: 0 }))), 12)}
  </div>`;
  drawSince(s.since);
  draw("c-hour", { x: { label: "hour", type: "band" }, y: { grid: true, label: null }, marks: [
    Plot.barY(s.perHour, { x: "hour", y: "today", fill: "#2b56b0", tip: true }), Plot.lineY(s.perHour, { x: "hour", y: "typical", stroke: "#5cc8ff", curve: "step" }),
  ] });
  if (s.platforms.length) draw("c-plat", { height: Math.max(120, 18 * s.platforms.length + 30), marginLeft: 50, x: { grid: true, label: null }, y: { label: null }, marks: [Plot.barX(s.platforms, { y: "p", x: "n", fill: "#5cc8ff", sort: { y: "-x" }, tip: true })] });
  if (s.daily.length) draw("c-days", { x: { type: "band", label: null, tickFormat: (d) => d.slice(5) }, y: { grid: true, label: "%", domain: [Math.min(70, d3.min(s.daily, (d) => d.pct) ?? 70), 100] }, marks: [Plot.barY(s.daily, { x: "date", y: "pct", fill: "#3ddc97", tip: true, title: (d) => `${d.date}: ${d.pct} % on time\n${n0(d.dep_obs)} of ${n0(d.deps)} departures with live data · average ${mins(d.avg_dep_delay)}` })] });
}

// ---------- line ----------
async function linePage(name, current) {
  const l = await api(`line/${encodeURIComponent(name)}`, true);
  if (!current()) return;
  if (!l) { main.innerHTML = `<div class="empty-page">No line ${esc(name)} today.</div>`; return; }
  document.title = `TrainNet — ${name}`;
  const done = l.today.filter((t) => t.observed && !t.cancelled), ok = done.filter((t) => t.final_delay < 180).length;
  main.innerHTML = `
  <div class="page-head"><div><h1>${badge(l.line)} <span class="sub" style="font-size:16px">${esc(l.operator)}</span></h1><p class="sub">${n0(l.trips)} trains today · ${n0(l.km)} train-km</p></div></div>
  <div class="kpis">
    ${kpi("Trains today", n0(l.trips))}
    ${kpi("Finished", n0(l.today.length), `${l.today.filter((t) => t.cancelled).length} cancelled`)}
    ${kpi("Punctual today", done.length ? pctv(Math.round((1000 * ok) / done.length) / 10) : "–", done.length ? `${ok} of ${done.length}` : "fills in as trains finish")}
    ${kpi("Average final delay", done.length ? mins(d3.mean(done, (t) => t.final_delay)) : "–")}
  </div>
  <div class="grid">
    ${card("Punctuality along the line", "Arrivals less than 3 min late at each stop, last 30 days; the line is the average arrival delay", l.stops.some((s) => s.n) ? ch("c-stops") : empty("Fills in as trains finish."), 12)}
    ${card("Trains today", "Finished trains", table([
      { h: "Arrival", f: (t) => time(t.arr) }, { h: "Train", f: (t) => esc(t.train_no) }, { h: "Route", f: (t) => `<span class="muted">${esc(t.origin)} → ${esc(t.dest)}</span>` },
      { h: "Delay", num: 1, f: (t) => (t.cancelled ? `<span style="color:#ff4d4d">cancelled</span>` : t.observed ? `<span style="color:${delayColor(t.final_delay)}">${mins(t.final_delay)}</span>` : "–") },
    ], l.today.map((t) => ({ ...t, _href: `#/train/${t.train_no}` })), "None finished yet."), 6)}
    ${card("Daily punctuality", "", l.daily.length ? ch("c-days") : empty("History builds up day by day."), 6)}
    ${sinceCard(l.since, `Line ${esc(l.line)}`)}
    ${card("Disruptions on this line", "Last 30 days", incidentTable(l.incidents.map((r) => ({ ...r, sudden: 0 }))), 12)}
  </div>`;
  drawSince(l.since);
  const lx = (s, k) => `${k}·${s.name}`, stops = l.stops.map((s, k) => ({ ...s, x: lx(s, k) })), maxArr = Math.max(3, d3.max(stops, (s) => (s.arr ?? 0) / 60) ?? 3);
  if (l.stops.some((s) => s.n)) draw("c-stops", { height: 260, marginBottom: 90, marginRight: 40, x: { type: "band", domain: stops.map((s) => s.x), tickRotate: -40, label: null, tickFormat: (v) => short(18)(v.split("·")[1]) }, y: { domain: [0, 100], grid: true, label: "%" }, marks: [
    Plot.barY(stops.filter((s) => s.n), { x: "x", y: "pct", fill: (s) => (s.pct >= 90 ? "#3ddc97" : s.pct >= 75 ? "#ffd23f" : "#ff4d4d"), tip: true, title: (s) => `${s.name}: ${s.pct} % on time · average ${mins(s.arr)} · ${s.n} arrivals` }),
    Plot.lineY(stops.filter((s) => s.n), { x: "x", y: (s) => (100 * (s.arr ?? 0)) / 60 / maxArr, stroke: "#ffb547", strokeWidth: 1.5, curve: "monotone-x" }), // average delay, scaled to the right axis
    Plot.axisY(d3.ticks(0, maxArr, 4).map((v) => (100 * v) / maxArr), { anchor: "right", label: "avg min", tickFormat: (v) => Math.round((v * maxArr) / 100) }),
  ] });
  if (l.daily.length) draw("c-days", { x: { type: "band", label: null, tickFormat: (d) => d.slice(5) }, y: { grid: true, label: "%" }, marks: [Plot.barY(l.daily, { x: "date", y: "pct", fill: "#3ddc97", tip: true, title: (d) => `${d.date}: ${d.pct} % on time\n${n0(d.trips)} trains · ${n0(d.cancelled)} cancelled · average ${mins(d.avg_delay)}` })] });
}

// ---------- incidents ----------
async function incidentsPage(current) {
  const r = await api("incidents");
  if (!current()) return;
  document.title = "TrainNet — Incidents";
  const live = r.rows.filter((x) => x.sev_max >= 2), byKind = d3.rollups(live, (v) => v.length, (x) => x.kind).map(([kind, n]) => ({ kind, n }));
  const longest = d3.max(live, (x) => x.last_seen - (x.since ?? x.first_seen));
  main.innerHTML = `
  <div class="page-head"><div><h1>Disruptions</h1><p class="sub">Everything the alerts feed reported for rail, last 30 days</p></div></div>
  <div class="kpis">
    ${kpi("Interruptions & restrictions", n0(live.length))}
    ${kpi("Sudden incidents", n0(r.rows.filter((x) => x.sudden).length), "unplanned, flagged in their first hour")}
    ${kpi("Most common", byKind.length ? esc(KIND[d3.greatest(byKind, (k) => k.n).kind]?.[0]) : "–")}
    ${kpi("Longest", longest ? `${n0(longest / 3600)}<small> h</small>` : "–")}
  </div>
  <div class="grid">
    ${card("Hotspots", "Stations named most often in interruptions and restrictions", ch("c-map"), 7)}
    ${card("By kind", "", byKind.length ? ch("c-kind") : empty("Nothing yet."), 5)}
    <section class="card w12"><h2>All reports</h2>
      <div class="filters">
        <select id="f-kind" aria-label="Kind"><option value="">All kinds</option>${Object.entries(KIND).map(([k, [l]]) => `<option value="${k}">${l}</option>`).join("")}</select>
        <select id="f-sev" aria-label="Severity"><option value="2">Interrupted & limited</option><option value="3">Interrupted</option><option value="1">Everything incl. planned</option></select>
        <input id="f-q" type="search" placeholder="Filter by text, station or line" aria-label="Filter">
        <span id="f-n" class="hint" style="align-self:center"></span>
      </div>
      <div id="f-list"></div>
    </section>
  </div>`;
  const render = () => {
    const kind = document.getElementById("f-kind").value, sev = +document.getElementById("f-sev").value, q = document.getElementById("f-q").value.toLowerCase();
    const rows = r.rows.filter((x) => (!kind || x.kind === kind) && (sev === 3 ? x.sev_max === 3 : x.sev_max >= sev)
      && (!q || `${x.h} ${x.why} ${x.stations.join(" ")} ${x.lines.join(" ")}`.toLowerCase().includes(q)));
    document.getElementById("f-n").textContent = `${rows.length} reports`;
    document.getElementById("f-list").innerHTML = table([
      { h: "Reported", f: (x) => `${dm(x.since ?? x.first_seen)} ${time(x.since ?? x.first_seen)}` },
      { h: "", f: (x) => sevChip(x.sev_max) }, { h: "Kind", f: (x) => kindChip(x.kind) },
      { h: "What", f: (x) => `${x.sudden ? "⚡ " : ""}${esc(x.h)}<br><span class="muted">${esc(x.why || CAUSE[x.cause] || "")}${x.lines.length ? ` · ${esc(x.lines.slice(0, 6).join(", "))}` : ""}</span>${x.d ? `<details class="desc"><summary>Details</summary>${esc(x.d)}${x.stations.length ? `<br><span class="muted">Stations: ${esc(x.stations.slice(0, 12).join(", "))}</span>` : ""}</details>` : ""}` },
      { h: "Duration", num: 1, f: (x) => duration(x.last_seen - (x.since ?? x.first_seen)) },
    ], rows.slice(0, 300).map((x) => ({ ...x, _href: Date.now() / 1000 - x.last_seen < 600 ? `/?alert=${encodeURIComponent(x.id)}` : undefined })), "Nothing matches.");
  };
  for (const id of ["f-kind", "f-sev", "f-q"]) document.getElementById(id).addEventListener("input", render);
  render();
  if (byKind.length) draw("c-kind", { marginLeft: 130, x: { grid: true, label: null }, y: { label: null, tickFormat: (k) => KIND[k]?.[0] ?? k }, color: kindColor, marks: [Plot.barX(byKind, { y: "kind", x: "n", fill: "kind", sort: { y: "-x" }, tip: true })] });
  const el = document.getElementById("c-map"), outline = await switzerland(), w = el.clientWidth || 600;
  el.replaceChildren(Plot.plot({
    width: w, height: Math.round(w * 0.62), projection: { type: "mercator", domain: outline, inset: 10 },
    style: { background: "transparent", color: "#8396bf", fontFamily: "Inter, system-ui, sans-serif", fontSize: "11px" },
    marks: [Plot.geo(outline, { fill: "#0b1a3d", stroke: "#3a6fd8", strokeOpacity: 0.7 }),
      Plot.dot(r.hotspots, { x: "lon", y: "lat", r: "n", fill: "#ff4d4d", fillOpacity: 0.55, stroke: "#ff4d4d", tip: true, title: (d) => `${d.name}: ${d.n} reports` })],
  }));
  el.insertAdjacentHTML("beforeend", r.hotspots.length ? `<div class="spot-links">${r.hotspots.slice(0, 12).map((h) => `<a href="#/station/${h.uic}">${esc(h.name)} <small>${h.n}</small></a>`).join("")}</div>` : empty("No station named yet."));
}

// ---------- search ----------
const q = document.getElementById("q"), results = document.getElementById("results");
let hits = [], cursor = 0, debounce, asked = 0;
const hrefOf = (h) => `#/${h.kind}/${encodeURIComponent(h.key)}`;
q.addEventListener("input", () => {
  clearTimeout(debounce);
  debounce = setTimeout(async () => {
    const mine = ++asked; // answers can arrive out of order: only the latest question's counts
    const found = q.value.trim() ? (await api(`search?q=${encodeURIComponent(q.value)}`).catch(() => [])) ?? [] : [];
    if (mine !== asked) return;
    hits = found;
    cursor = 0;
    results.innerHTML = hits.map((h, k) => `<li role="option" aria-selected="${k === 0}" data-k="${k}"><span class="kind">${h.kind}</span><span>${esc(h.label)}<br><small>${esc(h.sub)}</small></span><span class="kind">↵</span></li>`).join("");
    results.hidden = !hits.length;
    for (const li of results.children) li.onmousedown = (e) => { e.preventDefault(); go(+li.dataset.k); };
  }, 120);
});
const go = (k) => { if (hits[k]) { location.hash = hrefOf(hits[k]); q.value = ""; results.hidden = true; q.blur(); } };
q.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    cursor = (cursor + (e.key === "ArrowDown" ? 1 : hits.length - 1)) % Math.max(1, hits.length);
    [...results.children].forEach((li, k) => li.setAttribute("aria-selected", k === cursor));
  } else if (e.key === "Enter") go(cursor);
  else if (e.key === "Escape") { results.hidden = true; q.blur(); }
});
q.addEventListener("blur", () => setTimeout(() => (results.hidden = true), 150));
document.addEventListener("keydown", (e) => {
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName);
  if ((!typing && e.key === "/") || ((e.metaKey || e.ctrlKey) && e.key === "k")) { e.preventDefault(); q.focus(); }
});
