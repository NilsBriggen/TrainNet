// Shared by the phone views (plan, my trips, departures, a train as a list): small helpers and the station picker.
import { routeStyle } from "./colors.js";

export const $ = (id) => document.getElementById(id);
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const TIME = new Intl.DateTimeFormat("de-CH", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Zurich" });
export const hm = (unix) => TIME.format(unix * 1000);
/** "4 min", "1 h 05", "30 s"; no-break spaces, so a number never parts from its unit at a line end. */
export const mins = (s) => { if (s > 0 && s < 60) return `${Math.round(s)}\u00a0s`; const m = Math.max(0, Math.round(s / 60)); return m < 60 ? `${m}\u00a0min` : `${Math.floor(m / 60)}\u00a0h\u00a0${String(m % 60).padStart(2, "0")}`; };
/** "zurich" finds Zürich, "geneve" Genève. */
export const fold = (x) => x.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
export const delayText = (d) => (d >= 60 ? `<span class="${d >= 600 ? "very-late" : d >= 180 ? "late" : ""}">+${Math.round(d / 60)}′</span>` : "");
/** A line's badge from its route fields (line name, category, agency), coloured as on the map. */
export const badge = (line, cat, agency) => `<span class="badge" style="background:${routeStyle(line || cat, cat, agency).c}">${esc(line || cat)}</span>`;
export const LEVEL = ["", "low", "medium", "high"];
const meter = (o, cls) => (o ? `<span class="meter o${o}" title="${cls} class: ${LEVEL[o]} occupancy"><i></i><i></i><i></i></span>` : "");
export const meters = (o) => (o && (o[0] || o[1]) ? `<span class="meters">${meter(o[0], "1st")}${meter(o[1], "2nd")}</span>` : "");
export const json = (url) => fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))));
export const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(`trainnet.${k}`)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(`trainnet.${k}`, JSON.stringify(v)); } catch {} },
};

// stations: [name, uic, lon, lat, trains today, daily passengers]
let stationsP = null;
export const stations = () => (stationsP ??= json("/api/stations").then((j) => { j.folded = j.s.map((s) => fold(s[0])); j.byUic = new Map(j.s.map((s) => [s[1], s])); return j; })
  .catch((e) => { stationsP = null; throw e; })); // a failed load (a deploy, a dead spot) is asked again next time
/** Stations whose name contains q: names starting with it first, then the busiest. */
export function matchStations(st, q, n = 8) {
  q = fold(q.trim());
  if (!q) return [];
  const size = (s) => s[5] || s[4] * 40; // passengers where SBB counts them, else trains
  return st.s.map((s, i) => [s, i]).filter(([, i]) => st.folded[i].includes(q))
    .sort(([a, i], [b, j]) => +st.folded[j].startsWith(q) - +st.folded[i].startsWith(q) || size(b) - size(a)).slice(0, n).map(([s]) => s);
}
const km = (lon1, lat1, lon2, lat2) => Math.hypot((lon2 - lon1) * 111.32 * Math.cos((lat1 * Math.PI) / 180), (lat2 - lat1) * 110.54);
/** The nearest station with trains to the phone, within 3 km: [station, km] or null. */
export async function nearestStation() {
  const pos = await new Promise((ok, no) => navigator.geolocation ? navigator.geolocation.getCurrentPosition(ok, no, { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 }) : no(new Error("no location")));
  const st = await stations(), { longitude: lon, latitude: lat } = pos.coords;
  let best = null, d = 3;
  for (const s of st.s) { const x = km(lon, lat, s[2], s[3]); if (x < d) { d = x; best = s; } }
  return best && [best, d];
}

/**
 * A station field: type, pick from the list (tap, or arrows and Enter), or "near me". onPick(station) with the chosen
 * [name, uic, ...]; the input shows its name. Returns { set(station), get() }.
 */
export function stationPicker(input, list, nearBtn, onPick) {
  let picked = null, hits = [], cur = -1;
  const show = () => {
    list.innerHTML = hits.map((s, k) => `<li role="option" id="${list.id}-${k}" aria-selected="${k === cur}" data-k="${k}"><span>${esc(s[0])}</span><small>${s[4]} trains today</small></li>`).join("");
    list.hidden = !hits.length;
    input.setAttribute("aria-expanded", String(!list.hidden));
    input.setAttribute("aria-activedescendant", cur >= 0 ? `${list.id}-${cur}` : "");
  };
  const pick = (s) => { picked = s; input.value = s ? s[0] : ""; hits = []; show(); onPick(s); };
  input.addEventListener("input", async () => {
    picked = null;
    try { hits = matchStations(await stations(), input.value); } catch { hits = []; toast("Couldn't load the stations. Check your connection."); }
    cur = hits.length ? 0 : -1;
    show();
  });
  input.addEventListener("keydown", (e) => {
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && hits.length) { e.preventDefault(); cur = (cur + (e.key === "ArrowDown" ? 1 : hits.length - 1)) % hits.length; show(); }
    else if (e.key === "Enter" && hits[cur]) { e.preventDefault(); pick(hits[cur]); }
    else if (e.key === "Escape") { hits = []; show(); }
  });
  input.addEventListener("focus", () => input.select());
  input.addEventListener("blur", () => setTimeout(() => { hits = []; show(); if (!picked && input.value) input.value = ""; else if (picked) input.value = picked[0]; }, 150));
  list.addEventListener("pointerdown", (e) => { const li = e.target.closest("[data-k]"); if (li) { e.preventDefault(); pick(hits[+li.dataset.k]); } });
  nearBtn?.addEventListener("click", async () => {
    nearBtn.disabled = true;
    try { const r = await nearestStation(); r ? pick(r[0]) : toast("No station within 3 km."); }
    catch { toast("Your location isn't available."); }
    finally { nearBtn.disabled = false; }
  });
  return { set: (s) => { picked = s; input.value = s ? s[0] : ""; }, get: () => picked };
}

let toastTimer = 0;
export function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3500);
}
