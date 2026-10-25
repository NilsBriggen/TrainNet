// Stats pages: hash-routed, data from /api/stats/*, charts with Observable Plot (global `Plot` + `d3` from the CDN).
import { lineColor, trainKind } from "./colors.js";
import { FORMATION_WHY } from "./formation.js";

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
const dmy = (date) => `${+date.slice(8)}.${+date.slice(5, 7)}.`; // "2026-10-23" -> "23.10."
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
  infra: ["Infrastructure", "#9f8cff"], weather: ["Weather", "#5cc8ff"], police: ["Police / emergency", "#3ddc97"], staff: ["Staff shortage", "#e0a3ff"], other: ["Other", "#8396bf"],
};
const SEV = { 1: ["Planned", "#5a6b8c"], 2: ["Limited", "#ffb547"], 3: ["Interrupted", "#ff4d4d"] };
const CAUSE = { TECHNICAL_PROBLEM: "technical problem", ACCIDENT: "accident", WEATHER: "weather", CONSTRUCTION: "construction work", MAINTENANCE: "maintenance", POLICE_ACTIVITY: "police operation", MEDICAL_EMERGENCY: "medical emergency", STRIKE: "strike", DEMONSTRATION: "demonstration", HOLIDAY: "holiday", OTHER_CAUSE: "" };
const kindColor = { domain: Object.keys(KIND), range: Object.values(KIND).map((k) => k[1]), tickFormat: (k) => KIND[k]?.[0] ?? k };
const delayColor = (sec) => (sec >= 600 ? "#ff4d4d" : sec >= 180 ? "#ffd23f" : "#3ddc97");

// ---------- building blocks ----------
// lines are keys like "S1|8500010" (name + busiest station); shown by name, with the station where another line shares it
let LINES = {};
const lineLabel = (key) => LINES[key] ?? String(key ?? "").replace(/\|[^|]*$/, "");
// the category from the label when the page doesn't know it: "IC5" -> IC
const kindOf = (line) => { const n = lineLabel(line).split(" ")[0]; return trainKind(n, n.match(/^[A-Z]+/)?.[0] ?? ""); };
const badge = (line) => { const [k, about] = kindOf(line); return `<span class="badge" style="background:${lineColor(lineLabel(line).split(" ")[0])}"${k ? ` title="${esc(k + (about ? `: ${about}` : ""))}"` : ""}>${esc(lineLabel(line))}</span>`; }; // same colour as on the map
// a photo per train type (scripts/typephotos.ts: Wikimedia Commons, credited under the picture)
const photos = fetch("/types/photos.json").then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
const kindText = (line) => { const [k, about] = kindOf(line); return k ? `<b>${esc(k)}</b>${about ? ` · ${esc(about)}` : ""}` : ""; };
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
  [/^#\/types$/, "types", typesPage], [/^#\/type\/(\w{2,10})$/, "types", typePage], [/^#\/history$/, "history", historyPage],
  [/^#\/records$/, "records", recordsPage], [/^#\/network$/, "network", networkPage], [/^#\/commute(?:\/(\d{7})\/(\d{7}))?$/, "commute", commutePage],
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
      await fn(...m.slice(1).map((x) => x && decodeURIComponent(x)), () => token === nav); // pages check `current()` before writing
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
fetch("/api/stats/lines").then((r) => (r.ok ? r.json() : {})).catch(() => ({})).then((x) => { LINES = x; route(); });

// ---------- overview ----------
async function overview(current) {
  const o = await api("overview");
  if (!current()) return;
  const L = o.live, T = o.today, F = o.facts, H = o.history;
  document.title = "TrainNet — Stats";
  const finished = (T.observed ?? 0) - (T.cancelled ?? 0);
  main.innerHTML = `
  <div class="page-head"><div><h1>Swiss rail, today</h1><p class="sub">${day(o.date)} · <span class="live-dot"></span>${o.feedTime ? `live data from ${time(o.feedTime)}${Date.now() / 1000 - o.feedTime > 120 ? ` <b class="stale">(${n0((Date.now() / 1000 - o.feedTime) / 60)} min old)</b>` : ""}` : "no live data yet"}, refreshes every 30 s</p></div></div>
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
    ${F.allNight ? kpi("First / last departure", "all night", "night trains run tonight: no break in service") : kpi("First / last departure", `${F.first}<small> / ${F.last}</small>`)}
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
  if (T.cancelledByLine.length) draw("c-canc", { marginLeft: 60, x: { grid: true, label: null }, y: { label: null, tickFormat: lineLabel }, marks: [Plot.barX(T.cancelledByLine, { y: "line", x: "n", fill: "#ff4d4d", sort: { y: "-x" }, tip: true })] });
  if (T.incidents.length) incidentGantt("c-inc", T.incidents);
  draw("c-crowd", { x: { label: "hour", domain: [0, 24] }, y: { domain: [1, 3], grid: true, label: null }, marks: [Plot.areaY(o.crowding.byHour, { x: "hour", y1: 1, y2: "level", fill: "#ffb547", fillOpacity: 0.25, curve: "monotone-x" }), Plot.lineY(o.crowding.byHour, { x: "hour", y: "level", stroke: "#ffb547", curve: "monotone-x", tip: true })] });
  if (H.days.length) draw("c-days", { x: { type: "band", label: null, tickFormat: (d) => d.slice(5) }, y: { grid: true, label: "%", domain: [Math.min(80, d3.min(H.days, (d) => d.pct) ?? 80), 100] }, marks: [
    // a day recorded only in part (restarts, the first evening) is greyed: its figure isn't the day's
    Plot.barY(H.days, { x: "date", y: "pct", fill: (d) => (d.coverage >= 60 ? "#3ddc97" : "#41507a"), tip: true, title: (d) => `${d.date}: ${d.pct} % on time${d.coverage < 60 ? `\nonly ${d.coverage} % of trains recorded with live data` : ""}\n${n0(d.observed)} trains with live data · ${n0(d.cancelled)} cancelled\naverage final delay ${mins(d.avg_delay)} · 90th percentile ${mins(d.p90_delay)}` }),
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
  const ph = await photos;
  if (!current()) return;
  const unitsDate = t.vehicles[0]?.date, unitsToday = t.vehicles.filter((v) => v.date === unitsDate), unitsOld = unitsDate && unitsDate !== todayZH();
  const stops = run?.stops ?? [], cur = run?.at == null ? null : stops[Math.ceil(run.at)];
  const finished = t.history.filter((h) => h.observed && !h.cancelled), ok = finished.filter((h) => h.final_delay < 180).length;
  const status = !run ? "not running today" : run.cancelled ? "cancelled" : run.running ? `running · ${mins(cur?.delay)} at ${esc(cur?.name)}` : run.stops.at(-1).arr * 1000 < Date.now() ? `arrived ${mins(stops.at(-1).delay)}` : `departs ${time(stops[0].dep)}`;
  main.innerHTML = `
  <div class="page-head"><div><h1>${run ? badge(run.line, run.cat) : ""} ${esc(num)}</h1>
    ${run && kindText(run.line) ? `<p class="sub">${kindText(run.line)}</p>` : ""}<p class="sub">${run ? `${esc(run.operator)} · ${esc(stops[0].name)} → ${esc(stops.at(-1).name)} · ${status}` : "not running today"}</p></div>
    <div class="actions">${run ? `<a href="/?train=${encodeURIComponent(num)}">Show on map →</a>` : ""}</div></div>
  ${run?.stuckSince ? `<div class="callout quiet">Probably standing: its expected delay at the next stop has been rising since ${time(run.stuckSince)}. An inference from the forecasts, not a report.</div>` : ""}
  <div class="kpis">
    ${kpi("Now", run?.running ? mins(cur?.delay) : "–", run?.running ? `at ${esc(cur?.name)}` : "")}
    ${kpi("Distance", run ? `${n0(stops.at(-1).km)}<small> km</small>` : "–", run ? `${stops.length} stops` : "")}
    ${kpi("Trainsets", unitsToday.length || "–", unitsToday.length ? esc([...new Set(unitsToday.map((u) => u.type))].join(", ")) + (unitsOld ? ` · as on ${esc(unitsDate)}` : "") : run ? "asking…" : "not recorded", "kpi-units")}
    ${kpi("Days recorded", t.history.length + t.older.length)}
    ${kpi("Punctual", finished.length ? pctv(Math.round((1000 * ok) / finished.length) / 10) : "–", finished.length ? `${ok} of ${finished.length} recorded runs` : "no finished run recorded yet")}
    ${kpi("Average final delay", finished.length ? mins(d3.mean(finished, (h) => h.final_delay)) : "–", finished.length ? `worst ${mins(d3.max(finished, (h) => h.max_delay))} on the way` : "")}
    ${kpi("Probably standing", finished.length ? `${n0(d3.sum(t.history, (h) => h.stuck_min))}<small> min</small>` : "–", "inferred, all recorded days")}
  </div>
  <div class="grid">
    ${card("Today's run", "Delay at each stop (live forecast for the stops ahead)", stops.length ? ch("c-run") : empty("Not running today."), 8)}
    ${card("Trainsets", unitsOld ? `The physical units on ${esc(unitsDate)}: today's aren't recorded yet` : "The physical units running this train", `<div id="trainsets">${unitsToday.length ? unitsHtml(ph, unitsToday.map((u) => ({ id: u.unit, cls: clsOf(u.unit), type: u.type, km: u.km })))
      : run ? `<p class="muted">Asking the formation service…</p>` : empty("Not recorded: formations are crawled for long-distance trains once a day.")}</div>`, 4)}
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
  // regional trains aren't crawled: ask the formation service now, as the map's panel does (its answer is kept for the day)
  if (!unitsToday.length && run?.idx >= 0) {
    const live = await fetch(`/api/train/${run.idx}?v=${encodeURIComponent(t.v)}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const box = current() && document.getElementById("trainsets"), units = live?.units ?? [];
    if (!box) return;
    const types = live?.types ?? [];
    box.innerHTML = units.length ? unitsHtml(ph, units.map((u) => ({ ...u, km: null })))
      : types.length ? photoFigure(ph[types[0].cls], types[0].type) + `<p class="sub">${types.map((u) => `<a class="inline" href="#/type/${encodeURIComponent(u.cls)}">About the ${esc(u.type)} →</a>`).join(" · ")}</p><p class="muted">Today the formation service names its car types but not the vehicle numbers.</p>`
      : empty(["busy", "error", "offline"].includes(live?.formationStatus ?? "offline") ? "The formation service is busy or didn't answer: reload in a minute." // the map retries, this page doesn't
        : FORMATION_WHY[live.formationStatus]?.(live) ?? (live.formation ? "Its cars are listed, but without vehicle numbers that tell its trainsets." : "No formation for this train."));
    const k = document.querySelector(".kpi-units");
    if (k && units.length) (k.querySelector(".value").textContent = units.length), (k.querySelector(".note").textContent = [...new Set(units.map((u) => u.type))].join(", "));
  }
}

// ---------- vehicle ----------
async function vehiclePage(unit, current) {
  const v = await api(`vehicle/${encodeURIComponent(unit)}`, true);
  if (!current()) return;
  if (!v?.spec) { main.innerHTML = `<div class="empty-page">No runs recorded for ${esc(unit)} yet. Trainsets are recorded from the daily crawl of long-distance formations.</div>`; return; }
  document.title = `TrainNet — ${v.spec.type} ${unit}`;
  const ph = (await photos)[v.spec.class];
  if (!current()) return;
  const km = d3.sum(v.runs, (r) => r.km), now = v.now;
  const reg = v.register, age = reg?.built ? Math.floor((Date.now() - Date.parse(reg.built)) / (365.25 * 86400_000)) : null;
  main.innerHTML = `
  <div class="page-head"><div><h1><a class="type-link" href="#/type/${esc(v.spec.class)}">${esc(v.spec.type)}</a> <span style="color:var(--muted)">${esc(unit)}</span></h1>
    <p class="sub">${reg?.subtype ? `${esc(reg.subtype)} · ` : `Class ${esc(v.spec.class)} · `}${reg?.built ? `built ${esc(reg.built)} (${age} years) · ` : ""}${v.runs.length} trains today</p></div>
    <div class="actions">${now ? `<a href="/?train=${encodeURIComponent(now.train)}">Where is it now? →</a>` : ""}</div>${photoFigure(ph, v.spec.type)}</div>
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
  // one row per type, ~22 px each: a fixed-height chart squeezed 26 labels on top of each other
  const rows = (n) => ({ height: 22 * n + 40, marginLeft: 110, marginRight: 36 });
  const valueBars = (x, fmt) => [Plot.barX(f.byType, { y: "type", x, fill: "type", sort: { y: "-x" }, tip: true }),
    Plot.text(f.byType, { y: "type", x, text: (d) => fmt(d[x]), textAnchor: "start", dx: 4, fill: "#8396bf" })];
  draw("c-types", { ...rows(types.length), x: { grid: true, label: null }, y: { label: null }, color: typeColor, marks: valueBars("units", n0) });
  draw("c-km", { ...rows(types.length), marginRight: 72, x: { grid: true, label: null }, y: { label: null }, color: typeColor, marks: valueBars("km", (v) => `${n0(v)} km`) });
  if (f.ages.length) draw("c-ages", { ...rows(new Set(f.ages.map((a) => a.type)).size), x: { label: "built", tickFormat: "d", grid: true }, y: { label: null, domain: d3.groupSort(f.ages, (g) => d3.median(g, (a) => a.year), (a) => a.type) }, color: typeColor,
    marks: [Plot.dot(f.ages, { x: "year", y: "type", fill: "type", r: 3, fillOpacity: 0.7, tip: true }), Plot.tickX(f.ages, Plot.groupY({ x: "median" }, { x: "year", y: "type", stroke: "#fff", strokeWidth: 2 }))] });
  const mix = f.mixByLine.flatMap((l) => l.types.map((t) => ({ line: l.line, ...t })));
  draw("c-mix", { height: 26 * f.mixByLine.length + 50, marginLeft: 130, x: { grid: true, label: null }, y: { label: null, domain: f.mixByLine.map((l) => l.line), tickFormat: lineLabel }, color: { ...typeColor, legend: true }, marks: [Plot.barX(mix, { y: "line", x: "n", fill: "type", tip: true })] });
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
  const full = h.years.filter((y) => y.days >= 330), best = d3.greatest(full, (y) => y.pct), worst = d3.least(full, (y) => y.pct), last = h.months.at(-1);
  const covid = (y) => (y === "2020" ? " · pandemic timetable" : "");
  main.innerHTML = `
  <div class="page-head"><div><h1>Since ${esc(h.first.slice(0, 4))}</h1><p class="sub">Every train of every day from the official actual data (Ist-Daten): ${n0(h.days)} days, ${esc(h.first)} to ${esc(h.last)}${h.missing ? ` · ${h.missing} days incomplete in the archive, left out of per-day figures` : ""}</p></div></div>
  <div class="kpis">
    ${kpi(`On time, ${esc(last.month)}`, pctv(last.pct), `latest month imported (${last.days} days) · arrival less than 3 min late at the last stop`, grade(last.pct))}
    ${best ? kpi("Best year", esc(best.year), `${best.pct} % on time${covid(best.year)}`, "good") : ""}
    ${worst ? kpi("Worst year", esc(worst.year), `${worst.pct} % on time${covid(worst.year)}`) : ""}
    ${kpi("Trains a day", n0(last.perDay), `in ${esc(last.month)}`)}
    ${kpi(`Cancelled, ${esc(last.month)}`, pctv(last.cancelledPct), `${n0(last.cancelled)} trains`)}
  </div>
  <div class="grid">
    ${card("Punctuality by month", "Trains arriving less than 3 min late at their last Swiss stop", ch("c-months"), 12)}
    ${card("Every day", "One row a year, one cell a day: punctuality; grey = incomplete in the archive. Storms, snow, the 2020 timetable and holiday lulls show up as stripes.", ch("c-cal"), 12)}
    ${h.movers ? card(`What changed, ${monthSpan(h.movers.period)} ${h.movers.year} vs ${h.movers.year - 1}`, "Change in punctuality, same months a year apart; at least 1,000 runs in both", `<div class="two">
      <div><h3 class="mini">Lines</h3>${moverTable(h.movers.lines, (r) => badge(r.key), (r) => `#/line/${encodeURIComponent(r.key)}`)}</div>
      <div><h3 class="mini">Stations (departures)</h3>${moverTable(h.movers.stations, (r) => esc(r.name), (r) => `#/station/${r.key}`)}</div></div>`, 12) : ""}
    ${card("Trains a day", "Average per month: you can see 2020", ch("c-perday"), 6)}
    ${card("Cancelled and extra trains", "Average per day, by year (the current year so far)", ch("c-years"), 6)}
    ${card("When it's worst", "Share of departures 3+ min late, by month of the year and hour", ch("c-season"), 12)}
    ${card("Lines by year", "Lines with at least 3,000 runs that year: least and most punctual", `<div class="filters"><select id="h-year" aria-label="Year">${h.lines.map((l) => `<option>${l.year}</option>`).join("")}</select></div><div id="h-lines"></div>`, 12)}
  </div>`;
  const M = everyMonth(h.months), have = M.filter((m) => m.pct != null);
  draw("c-months", { height: 260, x: { type: "time", label: null }, y: { grid: true, label: "%", domain: [Math.min(80, d3.min(M, (m) => m.pct) ?? 80), 100] }, marks: [
    Plot.areaY(M, { x: "date", y1: Math.min(80, d3.min(M, (m) => m.pct) ?? 80), y2: "pct", fill: "#3ddc97", fillOpacity: 0.12 }),
    Plot.lineY(M, { x: "date", y: "pct", stroke: "#3ddc97", strokeWidth: 1.6 }),
    Plot.tip(have, Plot.pointerX({ x: "date", y: "pct", title: (m) => `${m.month}: ${m.pct} % on time\n${n0(m.perDay)} trains a day · ${m.cancelledPct} % cancelled\naverage final delay ${mins(m.avgDelay)} (early = 0)${m.missing ? `\n${m.missing} days incomplete in the archive` : ""}` })),
  ] });
  draw("c-perday", { x: { type: "time", label: null }, y: { grid: true, label: null }, marks: [Plot.areaY(M, { x: "date", y: "perDay", fill: "#2b56b0", fillOpacity: 0.5 }), Plot.lineY(M, { x: "date", y: "perDay", stroke: "#5cc8ff" }), Plot.tip(have, Plot.pointerX({ x: "date", y: "perDay", title: (m) => `${m.month}: ${n0(m.perDay)} trains a day` }))] });
  const Y = h.years.flatMap((y) => [{ year: y.year, kind: "cancelled", n: y.cancelledPerDay }, { year: y.year, kind: "extra", n: y.extraPerDay }]);
  draw("c-years", { x: { axis: null }, fx: { label: null }, y: { grid: true, label: null }, color: { domain: ["cancelled", "extra"], range: ["#ff4d4d", "#5cc8ff"], legend: true },
    marks: [Plot.barY(Y, { x: "kind", fx: "year", y: "n", fill: "kind", tip: true }), Plot.ruleY([0])] });
  draw("c-season", { height: 300, marginLeft: 40, x: { label: "hour", domain: d3.range(24) }, y: { label: null, domain: d3.range(1, 13), tickFormat: (m) => ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1] },
    color: { scheme: "YlOrRd", legend: true, label: "% of departures 3+ min late" }, marks: [Plot.cell(h.season, { x: "hour", y: "month", fill: "late", inset: 1, tip: true })] });
  const years = [...new Set(h.calendar.map((c) => c[0].slice(0, 4)))].reverse(), monthStarts = [1, 32, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];
  const cal = h.calendar.map(([date, p, trips, partial]) => ({ date, year: date.slice(0, 4), doy: (Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8)) - Date.UTC(+date.slice(0, 4), 0, 1)) / 864e5 + 1, pct: p, trips, partial }));
  draw("c-cal", { height: 22 * years.length + 60, marginLeft: 44, marginBottom: 24, x: { type: "band", domain: d3.range(1, 367), axis: null, paddingInner: 0 }, y: { domain: years, label: null, tickSize: 0, paddingInner: 0.15 },
    color: { type: "linear", scheme: "RdYlGn", domain: [86, 97], clamp: true, legend: true, label: "% on time" }, marks: [
      Plot.cell(cal.filter((c) => !c.partial), { x: "doy", y: "year", fill: "pct", tip: true, title: (c) => `${day(c.date)}\n${c.pct} % on time · ${n0(c.trips)} trains` }),
      Plot.cell(cal.filter((c) => c.partial), { x: "doy", y: "year", fill: "#2a3550", title: (c) => `${day(c.date)}\nincomplete in the archive (${n0(c.trips)} trains)` }),
      Plot.axisX(monthStarts, { tickFormat: (d) => ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][monthStarts.indexOf(d)], tickSize: 0, label: null }),
    ] });
  const lines = () => {
    const y = h.lines.find((l) => l.year === document.getElementById("h-year").value);
    const t = (rows) => table([{ h: "Line", f: (r) => badge(r.line) }, { h: "Runs", num: 1, f: (r) => n0(r.trips) }, { h: "On time", num: 1, f: (r) => pctv(r.pct) }], rows.map((r) => ({ ...r, _href: `#/line/${encodeURIComponent(r.line)}` })));
    document.getElementById("h-lines").innerHTML = y ? `<div class="two"><div><h3 class="mini">Least punctual</h3>${t(y.worst)}</div><div><h3 class="mini">Most punctual</h3>${t(y.best)}</div></div>` : "";
  };
  document.getElementById("h-year").addEventListener("input", lines);
  lines();
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthSpan = (p) => p.split("–").map((m) => MONTHS[+m - 1]).join("–");
const signed = (x) => `<span style="color:${x > 0 ? "#3ddc97" : x < 0 ? "#ff7a4d" : "inherit"}">${x > 0 ? "+" : ""}${x.toFixed(1)}</span>`;
function moverTable(m, name, href) {
  const t = (rows) => table([{ h: "", f: name }, { h: "Before", num: 1, f: (r) => pctv(r.before) }, { h: "Now", num: 1, f: (r) => pctv(r.now) }, { h: "pts", num: 1, f: (r) => signed(r.delta) }],
    rows.map((r) => ({ ...r, _href: href(r) })), "Not enough runs to compare.");
  return `<p class="hint">Improved most</p>${t(m.up)}<p class="hint">Declined most</p>${t(m.down)}`;
}

// ---------- network ----------
async function networkPage(current) {
  const n = await api("network", true);
  if (!current()) return;
  document.title = "TrainNet — Network";
  if (!n) { main.innerHTML = `<div class="empty-page">SBB's train counts per line section aren't loaded yet. They're fetched once a week.</div>`; return; }
  const t = (rows, cols) => table([{ h: "Section", f: (x) => `${esc(x.a)} – ${esc(x.b)}<br><span class="muted">${esc(x.line)}</span>` }, ...cols], rows);
  main.innerHTML = `
  <div class="page-head"><div><h1>The network, ${esc(n.year)}</h1><p class="sub">Every train on every line section in a year, passenger and freight, from SBB's counts (${n0(n.sections)} sections on SBB, BLS, SOB and other networks)</p></div>
    <div class="actions"><a href="/">On the map: "Traffic" →</a></div></div>
  <div class="kpis">
    ${kpi("Train-km a year", n0(n.km), "on the counted sections")}
    ${kpi("Freight", pctv(n.freightShare), "of train-km")}
    ${kpi("Energy", n.kwhPerKm ? `${n.kwhPerKm}<small> kWh</small>` : "–", "per train-km, traction current")}
  </div>
  <div class="grid">
    ${card("Busiest sections", "Trains a day, both directions", t(n.busiest, [{ h: "Trains", num: 1, f: (x) => n0(x.perDay) }, { h: "Freight", num: 1, f: (x) => pctv(x.freight) }]), 6)}
    ${card("Freight corridors", "Freight trains a day", t(n.freight, [{ h: "Freight", num: 1, f: (x) => n0(x.freightPerDay) }, { h: "of all", num: 1, f: (x) => pctv(x.freight) }]), 6)}
    ${card("Heaviest sections", "Gross tonnes a day, trains included", t(n.heaviest, [{ h: "Tonnes", num: 1, f: (x) => n0(x.tonnesPerDay) }, { h: "Trains", num: 1, f: (x) => n0(x.perDay) }]), 12)}
    ${n.lines?.length ? card("Running time against the timetable, by line", "Between stops, last 30 days, on each line of the network (SBB's line numbers). Timetables carry reserves, so trains usually make up time (−); the lines at the top are where they lose it (+). Per 10 km of line, and the section where trains do worst",
      table([{ h: "Line", f: (x) => `<b>${esc(x.line)}</b> <span class="muted">${esc(x.name)}</span>` }, { h: "Per 10 km", num: 1, f: (x) => `${x.per10 > 0 ? "+" : x.per10 < 0 ? "−" : ""}${Math.abs(x.per10)} s` },
        { h: "Worst section", f: (x) => (x.worst ? `${esc(x.worst.a)} – ${esc(x.worst.b)} <span class="muted">km ${x.worst.from}–${x.worst.to} · ${x.worst.gain > 0 ? "+" : x.worst.gain < 0 ? "−" : ""}${Math.abs(x.worst.gain)} s a train</span>` : "–") },
        { h: "Train runs", num: 1, f: (x) => n0(x.runs) }], n.lines.slice(0, 20)), 12) : ""}
  </div>`;
}

// ---------- records ----------
async function recordsPage(current) {
  const r = await api("records");
  if (!current()) return;
  document.title = "TrainNet — Records";
  const best = r.bestDays[0], worst = r.worstDays[0], busiest = d3.greatest(r.hours, (h) => h.perDay);
  const dayRows = (rows, extra) => table([{ h: "Day", f: (x) => day(x.date) }, ...extra], rows);
  main.innerHTML = `
  <div class="page-head"><div><h1>Records</h1><p class="sub">The best and worst of Swiss rail since 2018 (official actual data), and of what we've recorded live</p></div></div>
  <div class="kpis">
    ${best ? kpi("Most punctual day", `${best.pct}<small>%</small>`, day(best.date), "good") : ""}
    ${worst ? kpi("Least punctual day", `${worst.pct}<small>%</small>`, day(worst.date), "bad") : ""}
    ${r.cancelDays[0] ? kpi("Most cancellations", n0(r.cancelDays[0].cancelled), `${day(r.cancelDays[0].date)} · ${r.cancelDays[0].pct} % of trains`) : ""}
    ${busiest ? kpi("Busiest hour", `${String(busiest.hour).padStart(2, "0")}:00`, `${n0(busiest.perDay)} departures on an average weekday`) : ""}
  </div>
  <div class="grid">
    ${card("Most punctual days", "Trains less than 3 min late at their last Swiss stop", dayRows(r.bestDays, [{ h: "On time", num: 1, f: (x) => pctv(x.pct) }, { h: "Trains", num: 1, f: (x) => n0(x.trips) }]), 4)}
    ${card("Least punctual days", "", dayRows(r.worstDays, [{ h: "On time", num: 1, f: (x) => pctv(x.pct) }, { h: "Trains", num: 1, f: (x) => n0(x.trips) }]), 4)}
    ${card("Most cancellations", "Share of the day's trains", dayRows(r.cancelDays, [{ h: "Cancelled", num: 1, f: (x) => n0(x.cancelled) }, { h: "", num: 1, f: (x) => pctv(x.pct) }]), 4)}
    ${card("A weekday, hour by hour", "Departures per hour on an average weekday since 2018 (bars) and the share leaving 3+ min late (line)", ch("c-hours"), 8)}
    ${card("Best and worst months", "", table([{ h: "Month", f: (m) => esc(m.month) }, { h: "On time", num: 1, f: (m) => pctv(m.pct) }, { h: "Trains a day", num: 1, f: (m) => n0(m.perDay) }], r.months), 4)}
    ${card("Longest delays, official data", "Largest arrival delay of a train in a month, since 2018", table([{ h: "Train", f: (x) => `${badge(x.line)} ${esc(x.train_no)}` }, { h: "Month", f: (x) => esc(x.month) }, { h: "Delay", num: 1, f: (x) => `<b>${duration(x.max_delay)}</b>` }],
      r.delays.map((x) => ({ ...x, _href: `#/train/${x.train_no}` }))), 6)}
    ${card("Longest delays, recorded live", "Last 30 days", table([{ h: "Train", f: (x) => `${badge(x.line)} ${esc(x.train_no)}` }, { h: "Day", f: (x) => dmy(x.date) }, { h: "Route", f: (x) => `<span class="muted">${esc(x.origin)} → ${esc(x.dest)}</span>` }, { h: "Delay", num: 1, f: (x) => `<b>${duration(x.max_delay)}</b>` }],
      r.delaysLive.map((x) => ({ ...x, _href: `#/train/${x.train_no}` }))), 6)}
    ${card("Longest disruptions", "Interruptions and restrictions since we started recording", table([{ h: "Since", f: (x) => when(x.start) }, { h: "Kind", f: (x) => kindChip(x.kind) }, { h: "What", f: (x) => `${esc(x.h)}<br><span class="muted">${esc(x.why)}</span>` }, { h: "Lasted", num: 1, f: (x) => duration(x.dur) }], r.disruptions), 12)}
    ${card("Fastest sections today", "Scheduled, Swiss sections ≥ 8 km", table([{ h: "Section", f: (x) => `${esc(x.from)} → ${esc(x.to)}` }, { h: "Train", f: (x) => `<span class="muted">${esc(x.train)}</span>` }, { h: "km/h", num: 1, f: (x) => `<b>${x.kmh}</b>` }], r.fastest), 4)}
    ${card("Longest journeys today", "", table([{ h: "Train", f: (x) => esc(x.train) }, { h: "Route", f: (x) => `<span class="muted">${esc(x.from)} → ${esc(x.to)}</span>` }, { h: "km", num: 1, f: (x) => n0(x.km) }], r.longest.map((x) => ({ ...x, _href: `#/train/${x.num}` }))), 4)}
    ${card("Longest non-stop runs", "", table([{ h: "Section", f: (x) => `${esc(x.from)} – ${esc(x.to)}` }, { h: "km", num: 1, f: (x) => n0(x.km) }], r.longestNonstop), 4)}
  </div>`;
  const maxLate = Math.max(10, d3.max(r.hours, (h) => h.late) ?? 10), maxN = d3.max(r.hours, (h) => h.perDay) ?? 1;
  draw("c-hours", { x: { label: "hour", type: "band" }, y: { grid: true, label: "departures" }, marks: [
    Plot.barY(r.hours, { x: "hour", y: "perDay", fill: "#2b56b0", tip: true, title: (h) => `${h.hour}:00–${h.hour + 1}:00\n${n0(h.perDay)} departures · ${h.late} % 3+ min late` }),
    Plot.lineY(r.hours, { x: "hour", y: (h) => (h.late / maxLate) * maxN, stroke: "#ffb547", strokeWidth: 1.6, curve: "monotone-x" }),
    Plot.axisY(d3.ticks(0, maxLate, 4).map((v) => (v / maxLate) * maxN), { anchor: "right", label: "% late", tickFormat: (v) => Math.round((v / maxN) * maxLate) }),
  ] });
}

// ---------- commute ----------
/** A station picker: type, pick from the stats search (stations only). */
function stationPicker(id, label, value) {
  return `<label class="picker"><span>${label}</span><input id="${id}" type="search" autocomplete="off" placeholder="Station" value="${esc(value?.name ?? "")}" data-uic="${esc(value?.uic ?? "")}"><ul class="pick" hidden></ul></label>`;
}
function wirePicker(id, onPick) {
  const input = document.getElementById(id), list = input.nextElementSibling;
  let seq = 0;
  input.addEventListener("input", async () => {
    const my = ++seq, q = input.value.trim();
    if (q.length < 2) return void (list.hidden = true);
    const rows = (await api(`search?q=${encodeURIComponent(q)}`)).filter((x) => x.kind === "station").slice(0, 6);
    if (my !== seq) return;
    list.innerHTML = rows.map((x) => `<li><button type="button" data-uic="${esc(x.key)}">${esc(x.label)}</button></li>`).join("") || `<li class="muted">No station</li>`;
    list.hidden = false;
  });
  list.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-uic]");
    if (!b) return;
    input.value = b.textContent;
    input.dataset.uic = b.dataset.uic;
    list.hidden = true;
    onPick();
  });
}
async function commutePage(a, b, current) {
  const c = a && b ? await api(`commute/${a}/${b}`, true) : null;
  if (!current()) return;
  document.title = c ? `TrainNet — ${c.a.name} → ${c.b.name}` : "TrainNet — Your commute";
  main.innerHTML = `
  <div class="page-head"><div><h1>Your commute</h1><p class="sub">Two stations: how punctual the trains from one to the other were, by hour, over the last 30 days we recorded</p></div></div>
  <div class="card w12 pickers">${stationPicker("c-from", "From", c?.a ?? (a && { uic: a, name: a }))}<button type="button" class="swap" id="c-swap" title="Swap">⇄</button>${stationPicker("c-to", "To", c?.b ?? (b && { uic: b, name: b }))}</div>
  ${!a || !b ? "" : !c ? `<div class="empty-page">No recorded train ran from one to the other: they may not be on the same line, or nothing was recorded yet.</div>` : !c.runs ? `<div class="empty-page">No train from ${esc(c.a.name)} to ${esc(c.b.name)} recorded in the last 30 days.</div>` : `
  <div class="kpis">
    ${kpi("On time at " + esc(c.b.name), pctv(c.pct), `${n0(c.runs)} runs over ${c.days} days, less than 3 min late`, grade(c.pct))}
    ${kpi("Usual delay", mins(c.median), `median arrival delay · 1 in 10 runs ${mins(c.p90)} or more`)}
    ${kpi("Trains a day", n0(c.perDay), "recorded with live data")}
    ${kpi("Travel time", `${n0(c.minutes / 60)}<small> min</small>`, "scheduled, typical")}
  </div>
  <div class="grid">
    ${card("By hour of departure", `Leaving ${esc(c.a.name)}: share on time at ${esc(c.b.name)} (bars), usual and 1-in-10 delay (lines, minutes)`, ch("c-commute"), 8)}
    ${card("Trains", "Most frequent first", table([{ h: "Dep.", f: (t) => `${String(Math.floor(t.dep / 60)).padStart(2, "0")}:${String(t.dep % 60).padStart(2, "0")}` }, { h: "Train", f: (t) => `${badge(t.line)} ${esc(t.train_no)}` }, { h: "Runs", num: 1, f: (t) => t.n }, { h: "On time", num: 1, f: (t) => pctv(t.pct) }],
      c.trains.map((t) => ({ ...t, _href: `#/train/${t.train_no}` }))), 4)}
  </div>`}`;
  const go = () => { const x = document.getElementById("c-from").dataset.uic, y = document.getElementById("c-to").dataset.uic; if (x && y) location.hash = `#/commute/${x}/${y}`; };
  wirePicker("c-from", go);
  wirePicker("c-to", go);
  document.getElementById("c-swap").onclick = () => { if (a && b) location.hash = `#/commute/${b}/${a}`; };
  if (c?.runs) {
    const H = c.hours.map((h) => ({ ...h, med: h.median / 60, p90m: h.p90 / 60 })), maxM = Math.max(3, d3.max(H, (h) => h.p90m) ?? 3);
    draw("c-commute", { x: { label: "hour", type: "band" }, y: { domain: [0, 100], grid: true, label: "% on time" }, marks: [
      Plot.barY(H, { x: "hour", y: "pct", fill: (h) => (h.pct >= 90 ? "#3ddc97" : h.pct >= 75 ? "#ffd23f" : "#ff4d4d"), tip: true, title: (h) => `${h.hour}:00–${h.hour + 1}:00 · ${h.n} runs\n${h.pct} % on time · usual ${mins(h.median)} · 1 in 10 ${mins(h.p90)}` }),
      Plot.lineY(H, { x: "hour", y: (h) => (100 * Math.max(0, h.med)) / maxM, stroke: "#5cc8ff", strokeWidth: 1.6 }),
      Plot.lineY(H, { x: "hour", y: (h) => (100 * Math.max(0, h.p90m)) / maxM, stroke: "#ffb547", strokeWidth: 1.4, strokeDasharray: "3,3" }),
      Plot.axisY(d3.ticks(0, maxM, 4).map((v) => (100 * v) / maxM), { anchor: "right", label: "min", tickFormat: (v) => Math.round((v * maxM) / 100) }),
    ] });
  }
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
      t.seats ? `<span>${n0(t.seats)} seats</span>` : "", t.kmToday ? `<span>${n0(t.kmToday)} km today</span>` : "",
      t.punctuality ? `<span title="Trains it ran, last 30 days, against all trains of the same lines">${t.punctuality.pct} % on time (${signed(t.punctuality.delta)} vs its lines)</span>` : ""].filter(Boolean).join("")}</div>
    ${t.lines.length ? `<div class="type-lines">${t.lines.map(badge).join("")}</div>` : ""}
  </a>`).join("")}</div>`;
}

const clsOf = (unit) => unit.slice(0, unit.lastIndexOf("-")); // "502" of 502-213, "ABe416" of ABe416-3145
/** The first unit's photo and type, then a chip per unit: recorded ones (with km) open their own page, live ones their type's */
const unitsHtml = (ph, units) => {
  const types = [...new Map(units.map((u) => [u.cls, u])).values()];
  return photoFigure(ph[units[0].cls], units[0].type)
    + `<p class="sub">${types.map((u) => `<a class="inline" href="#/type/${encodeURIComponent(u.cls)}">About the ${esc(u.type)} →</a>`).join(" · ")}</p>`
    + `<div class="units">${units.map((u) => { const p = ph[u.cls]; return `<a class="unit-chip" href="${u.km != null ? `#/vehicle/${encodeURIComponent(u.id)}` : `#/type/${encodeURIComponent(u.cls)}`}">${p ? `<img src="${esc(p.src)}" alt="">` : ""}${esc(u.type)} <b>${esc(u.id)}</b>${u.km != null ? `<small>${n0(u.km)} km</small>` : ""}</a>`; }).join("")}</div>`;
};
/** A type's photo with its credit (licence terms: author, licence, source) */
const photoFigure = (ph, name) => (ph ? `<figure class="type-photo"><img src="${esc(ph.src)}" alt="${esc(name)}" width="480" height="320"><figcaption>Photo: <a href="${esc(ph.page)}" target="_blank" rel="noopener">${esc(ph.author)}</a> · ${ph.licenceUrl ? `<a href="${esc(ph.licenceUrl)}" target="_blank" rel="noopener">${esc(ph.licence)}</a>` : esc(ph.licence)} · Wikimedia Commons</figcaption></figure>` : "");
/** "Mostly on IR27 (Basel SBB – Luzern) and IR70 …; also IC1, IR15." from the type's usual lines */
function usualText(usual) {
  const main = usual.filter((u) => u.pct >= 10).slice(0, 3), rest = usual.filter((u) => !main.includes(u)).slice(0, 4);
  if (!main.length) return `Runs on ${usual.slice(0, 5).map((u) => lineLabel(u.line)).join(", ")}.`;
  const names = main.map((u) => `${lineLabel(u.line)} (${u.ends})`);
  return `Mostly on ${names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0]}${rest.length ? `; also ${rest.map((u) => lineLabel(u.line)).join(", ")}` : ""} (last 30 days).`;
}
async function typePage(cls, current) {
  const t = await api(`type/${cls}`, true);
  if (!current()) return;
  if (!t) { main.innerHTML = `<div class="empty-page">Nothing known about series ${esc(cls)} yet.</div>`; return; }
  document.title = `TrainNet — ${t.name}`;
  const running = t.units.filter((u) => u.runsToday), year = new Date().getFullYear(), ph = (await photos)[t.cls];
  if (!current()) return;
  main.innerHTML = `
  <div class="page-head"><div><h1>${esc(t.name)} <span style="color:var(--muted)">series ${esc(t.cls)}</span></h1>
    <p class="sub">${t.about ? esc(t.about) : ""}${t.usual?.length ? ` ${usualText(t.usual)}` : ""}${t.wiki ? ` <a class="inline" href="${esc(t.wiki)}" target="_blank" rel="noopener">Wikipedia ↗</a>` : ""}</p></div>
    ${photoFigure(ph, t.name)}</div>
  <div class="kpis">
    ${kpi("In service today", n0(running.length), `of ${n0(t.units.length)} units known`)}
    ${kpi("Distance today", `${n0(d3.sum(running, (u) => u.kmToday))}<small> km</small>`, running.length ? `${n0(d3.mean(running, (u) => u.kmToday))} km per unit` : "")}
    ${kpi("Recorded in total", `${n0(d3.sum(t.units, (u) => u.kmTotal))}<small> km</small>`, "since we started recording")}
    ${t.punctuality ? kpi("On time, 30 days", pctv(t.punctuality.pct), `${signed(t.punctuality.delta)} points vs all trains of the same lines · ${n0(t.punctuality.runs)} runs`, grade(t.punctuality.pct)) : ""}
    ${kpi("Built", t.years.length ? `${d3.min(t.years)}${d3.max(t.years) !== d3.min(t.years) ? `<small>–${d3.max(t.years)}</small>` : ""}` : "–", t.years.length ? `average age ${n0(year - d3.mean(t.years))} years` : "not in SBB's register")}
  </div>
  <div class="grid">
    ${t.usual?.length ? card("Where it runs", "Its lines over the last 30 days, share of its train runs, between the stations it serves most", table([{ h: "Line", f: (r) => badge(r.line) }, { h: "Mostly", f: (r) => `<span class="muted">${esc(r.ends)}</span>` }, { h: "Share", num: 1, f: (r) => `${r.pct} %` }],
      t.usual.map((r) => ({ ...r, _href: `#/line/${encodeURIComponent(r.line)}` }))), 8) : ""}
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
    ${kpi(`Departures on time${s.first ? `, since ${dmy(s.first)}` : ""}`, pctv(s.month.pct), s.month.n ? `${n0(s.month.n)} departures` : "")}
    ${kpi(`Arrivals on time${s.first ? `, since ${dmy(s.first)}` : ""}`, pctv(s.month.arrPct))}
    ${kpi("Delay hand-over", s.month.n ? `${mins(s.month.arr)}<small> → ${mins(s.month.avg)}</small>` : "–", "average arriving → departing delay")}
  </div>
  <div class="grid">
    ${card("Departures per hour", `Bars: today's timetable${s.typicalDays ? ` · line: departures recorded with live data, average of the last ${s.typicalDays} ${new Date().toLocaleDateString("en-GB", { weekday: "long", timeZone: ZH })}s` : ""}`, ch("c-hour"), 8)}
    ${card("Platforms", "Departures per platform today", s.platforms.length ? ch("c-plat") : empty("–"), 4)}
    ${s.busy.length ? card("When it's busy", `Share of the station's daily users by hour (SBB count, ${s.busy[0].year})`, ch("c-busy"), 6) : ""}
    ${s.edges.length ? card("Platform edges", "Length and height of each platform edge (SBB survey for step-free access)", table([{ h: "Track", f: (x) => esc(x.track) }, { h: "Length", num: 1, f: (x) => `${n0(x.length_m)} m` },
      { h: "Height", num: 1, f: (x) => (x.height_cm ? `${x.height_cm} cm` : "–") }, { h: "", f: (x) => `<span class="muted">${esc(x.type)}</span>` }], s.edges), 6) : ""}
    ${card("Lines", "Departures per line today", table([{ h: "Line", f: (r) => badge(r.line) }, { h: "Departures", num: 1, f: (r) => r.n }], s.lines.map((r) => ({ ...r, _href: `#/line/${encodeURIComponent(r.line)}` }))), 4)}
    ${card("Daily punctuality", "Departures less than 3 min late; hover for the average departure delay", s.daily.length ? ch("c-days") : empty("History builds up day by day."), 8)}
    ${sinceCard(s.since, "Departures here")}
    ${card("Disruptions here", "Last 30 days", incidentTable(s.incidents.map((r) => ({ ...r, sudden: 0 }))), 12)}
  </div>`;
  drawSince(s.since);
  draw("c-hour", { x: { label: "hour", type: "band" }, y: { grid: true, label: null }, marks: [
    Plot.barY(s.perHour, { x: "hour", y: "today", fill: "#2b56b0", tip: true }), ...(s.typicalDays ? [Plot.lineY(s.perHour, { x: "hour", y: "typical", stroke: "#5cc8ff", curve: "step" })] : []),
  ] });
  if (s.busy.length) draw("c-busy", { x: { label: "hour", type: "band", domain: d3.range(24) }, y: { grid: true, label: "% of the day" }, marks: [
    Plot.barY(s.busy, { x: "hour", y: "pct", fill: "#ffb547", fillOpacity: 0.85, tip: true, title: (h) => `${h.hour}:00–${h.hour + 1}:00\n${h.pct.toFixed(1)} % of the day's users` })] });
  if (s.platforms.length) draw("c-plat", { height: Math.max(120, 18 * s.platforms.length + 30), marginLeft: 50, x: { grid: true, label: null }, y: { label: null }, marks: [Plot.barX(s.platforms, { y: "p", x: "n", fill: "#5cc8ff", sort: { y: "-x" }, tip: true })] });
  if (s.daily.length) draw("c-days", { x: { type: "band", label: null, tickFormat: (d) => d.slice(5) }, y: { grid: true, label: "%", domain: [Math.min(70, d3.min(s.daily, (d) => d.pct) ?? 70), 100] }, marks: [Plot.barY(s.daily, { x: "date", y: "pct", fill: "#3ddc97", tip: true, title: (d) => `${d.date}: ${d.pct} % on time\n${n0(d.dep_obs)} departures recorded · average ${mins(d.avg_dep_delay)}` })] });
}

// ---------- line ----------
async function linePage(name, current) {
  const l = await api(`line/${encodeURIComponent(name)}`, true);
  if (!current()) return;
  if (!l) { main.innerHTML = `<div class="empty-page">No line ${esc(lineLabel(name))} today.</div>`; return; }
  document.title = `TrainNet — ${lineLabel(l.line)}`;
  const done = l.today.filter((t) => t.observed && !t.cancelled), ok = done.filter((t) => t.final_delay < 180).length;
  main.innerHTML = `
  <div class="page-head"><div><h1>${badge(l.line)} <span class="sub" style="font-size:16px">${esc(l.operator)}</span></h1>${kindText(l.line) ? `<p class="sub">${kindText(l.line)}</p>` : ""}<p class="sub">${l.trips ? `${n0(l.trips)} trains today · ${n0(l.km)} train-km` : "Not running today: its history"}</p></div></div>
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
    ${sinceCard(l.since, `Line ${esc(lineLabel(l.line))}`)}
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
