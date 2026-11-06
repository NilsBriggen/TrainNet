// The page's frame: on phones a bottom tab bar (Plan · My trips · Departures · Map) over lists, the map loaded only when
// its tab is opened; on wide screens the map as before, with Plan, My trips and Departures as a card beside it.
import { applyDelays, locate } from "./position.js";
import { routeStyle } from "./colors.js";
import { $, badge, delayText, esc, hm, json, stationPicker, store, stations } from "./ui.js";
import { initPlan } from "./plan.js";
import { initTrips } from "./trips.js";

const phone = matchMedia("(max-width: 760px)").matches;
const ready = new Promise((ok) => addEventListener("trainnet:ready", ok, { once: true })); // app.js: map and timetable loaded
let appP = null;
const app = () => (appP ??= import("./app.js").then(() => ready));

// detail views (a train, a journey) are history entries on phones, so Back closes them
const closers = [];
addEventListener("popstate", () => { if (closers.length) closers.pop()(); });
const detail = (close) => { history.pushState({ tn: closers.length + 1 }, ""); closers.push(close); };
const back = () => (closers.length ? history.back() : null);

let view = null;
const views = { plan: $("v-plan"), trips: $("v-trips"), board: $("v-board"), train: $("v-train") };
function go(name) {
  if (name === "map") {
    document.body.classList.remove("views");
    app().then(() => dispatchEvent(new Event("resize"))); // the map was under the lists: let it measure itself
  } else {
    document.body.classList.add("views");
    for (const [k, el] of Object.entries(views)) el.hidden = k !== name;
    if (name !== "train") refreshers[name]?.();
  }
  view = name;
  for (const b of $("tabs").querySelectorAll("[data-view]")) b.setAttribute("aria-selected", String(b.dataset.view === (name === "train" ? lastTab : name)));
  if (name !== "train") lastTab = name;
  $("plan-btn")?.setAttribute("aria-pressed", String(document.body.classList.contains("views")));
}
let lastTab = "plan";
$("tabs").addEventListener("click", (e) => { const b = e.target.closest("[data-view]"); if (b) go(b.dataset.view); });
$("plan-btn")?.addEventListener("click", () => (document.body.classList.contains("views") ? (document.body.classList.remove("views"), $("plan-btn").setAttribute("aria-pressed", "false")) : go(lastTab)));
$("views-close")?.addEventListener("click", () => { document.body.classList.remove("views"); $("plan-btn").setAttribute("aria-pressed", "false"); });

/** What the views can ask of the page: open a train, show a journey on the map, go to a tab. */
const nav = {
  phone, go, back, detail,
  /** row: { i, v, num, line, cat, agency, head } as the APIs answer. Phones: the train as a list; wide screens: its panel on the map. */
  openTrain(row) {
    if (phone) return showTrain(row);
    app().then(() => dispatchEvent(new CustomEvent("trainnet:open", { detail: row })));
  },
  /** On the map: a train's panel ({ i, v, num }) or a journey's legs ({ v, legs: [{ i, num, from, to }] }). */
  onMap(detail) {
    if (phone) go("map");
    app().then(() => dispatchEvent(new CustomEvent(detail.legs ? "trainnet:journey" : "trainnet:open", { detail })));
  },
};

// ---------- departures ----------
const boardEl = views.board;
boardEl.innerHTML = `<h2 class="view-title">Departures</h2>
  <div class="field"><label for="b-st">Station</label><input id="b-st" type="search" placeholder="Station" autocomplete="off" spellcheck="false" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="b-st-list">
    <button id="b-near" class="icon" title="Nearest station" aria-label="Nearest station"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="5.2" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="10" cy="10" r="1.9" fill="currentColor"/><path d="M10 1.8v2.6M10 15.6v2.6M1.8 10h2.6M15.6 10h2.6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg></button>
    <ul id="b-st-list" class="picks" role="listbox" hidden></ul></div>
  <ol id="b-rows" class="stops deps" aria-live="polite"></ol>`;
let boardSt = null, boardRows = [];
const boardPick = stationPicker($("b-st"), $("b-st-list"), $("b-near"), (s) => { boardSt = s; if (s) store.set("board", s[1]); loadBoard(); });
async function loadBoard() {
  if (!boardSt) return void ($("b-rows").innerHTML = `<li class="empty">Pick a station, or the nearest one with the button.</li>`);
  try {
    const j = await json(`/api/board/${boardSt[1]}`);
    boardRows = j.rows;
    $("b-rows").innerHTML = j.rows.map((r, k) => `<li data-k="${k}" role="button" tabindex="0"><span>${hm(r.dep)}</span>${badge(r.line, r.cat, r.agency)}<span class="name">→ ${esc(r.to)}</span><span class="pl">${r.pl ? `Pl. ${esc(r.pl)}` : ""}</span><span>${r.c ? `<span class="very-late">cancelled</span>` : r.skip ? `<span class="very-late">not stopping</span>` : delayText(r.delay)}</span></li>`).join("")
      || `<li class="empty">No train leaves here in the next 90 minutes.</li>`;
  } catch { $("b-rows").innerHTML = `<li class="empty">Couldn't load the departures. Retrying…</li>`; }
}
$("b-rows").addEventListener("click", (e) => { const li = e.target.closest("[data-k]"); if (li) nav.openTrain(boardRows[+li.dataset.k]); });
$("b-rows").addEventListener("keydown", (e) => { const li = e.target.closest("[data-k]"); if (li && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); nav.openTrain(boardRows[+li.dataset.k]); } });
stations().then((st) => { const s = st.byUic.get(store.get("board", "")); if (s) { boardSt = s; boardPick.set(s); } });

// ---------- a train as a list (phones) ----------
const trainEl = views.train;
let trainRow = null, trainData = null;
async function showTrain(row) {
  const from = view;
  trainRow = row; trainData = null;
  trainEl.innerHTML = `<button class="back" data-back>‹ Back</button><div class="empty">Loading…</div>`;
  go("train");
  detail(() => go(from && from !== "train" ? from : lastTab));
  await loadTrain();
}
async function loadTrain() {
  if (!trainRow) return;
  try { trainData = await json(`/api/trip/${trainRow.i}?v=${encodeURIComponent(trainRow.v ?? "")}`); }
  catch { return void (trainEl.querySelector(".empty") && (trainEl.querySelector(".empty").textContent = "This train isn't in today's timetable any more.")); }
  renderTrain();
}
function renderTrain() {
  const t = trainData, base = t.base / 1000, e = applyDelays(t.stops, t.u), now = Date.now() / 1000 - base, p = locate(e.stops, now), n = t.stops.length / 3;
  const status = t.c ? `<span class="very-late">Cancelled</span>` : p ? `${p.at ? "At" : "Next:"} ${esc(t.names[p.b][0])}` : now < e.stops[2] ? `Departs ${hm(base + e.stops[2])}` : "Arrived";
  const rows = Array.from({ length: n }, (_, k) => {
    const sched = k === 0 ? t.stops[2] : t.stops[k * 3 + 1], ex = k === 0 ? e.stops[2] : e.stops[k * 3 + 1], past = (k === 0 ? e.stops[2] : e.stops[k * 3 + 2]) < now;
    return `<li class="${past ? "past" : ""}${e.skipped[k] ? " skipped" : ""}"><span>${hm(base + sched)}</span><span class="exp">${delayText(ex - sched)}</span><span class="name">${esc(t.names[k][0])}</span><span class="pl">${t.plat[k] ? `Pl. ${esc(t.plat[k])}` : ""}</span><span></span></li>`;
  }).join("");
  trainEl.innerHTML = `<button class="back" data-back>‹ Back</button>
    <h2 class="view-title">${badge(t.line, t.cat, t.agency)} ${esc(t.num)}</h2><div class="sub">→ ${esc(t.head)} · ${status}</div>
    <div class="actions"><button data-onmap>On the map</button></div>
    <ol class="stops stem" style="--line:${routeStyle(t.line || t.cat, t.cat, t.agency).c}">${p && !t.c ? `<span class="pos"></span>` : ""}${rows}</ol>`;
  const stem = trainEl.querySelector(".stem"), lis = stem.querySelectorAll(":scope > li"), mid = (k) => lis[k].offsetTop + 15;
  const y = p ? mid(p.a) + (mid(p.b) - mid(p.a)) * (p.at ? 0 : p.f) : now < e.stops[2] ? mid(0) : mid(n - 1);
  for (const [v, px] of [["--y0", mid(0)], ["--y1", mid(n - 1)], ["--y", y]]) stem.style.setProperty(v, `${px}px`);
}
trainEl.addEventListener("click", (e) => {
  if (e.target.closest("[data-back]")) back();
  if (e.target.closest("[data-onmap]")) nav.onMap({ i: trainRow.i, v: trainRow.v, num: trainRow.num });
});

// ---------- start ----------
const plan = initPlan(views.plan, nav), trips = initTrips(views.trips, nav);
const refreshers = { plan: plan.refresh, trips: trips.refresh, board: loadBoard };
setInterval(() => {
  if (document.hidden || !document.body.classList.contains("views")) return;
  if (view === "train") loadTrain(); else refreshers[view]?.();
}, 30_000);
const deep = ["train", "station", "alert", "line"].some((k) => new URL(location.href).searchParams.has(k)); // a shared link opens the map
if (phone && !deep) go("plan");
else { app(); if (!phone) go(lastTab), document.body.classList.remove("views"); else go("map"); }
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
