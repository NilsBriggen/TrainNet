// My trips: journeys you follow, kept on this device, with their live state (leave in …, on which train, will the change work).
import { applyDelays } from "./position.js";
import { $, badge, delayText, esc, hm, json, mins, store } from "./ui.js";

const key = (j, v) => `${v}|${j.legs.map((l) => `${l.i}:${l.from.k}`).join(",")}`;
const all = () => store.get("trips", []);
export const isFollowed = (j, v) => all().some((t) => t.id === key(j, v));
/** Keep a journey from /api/plan (with its day version, as trip indexes are per day). */
export function saveTrip(j, v) {
  const id = key(j, v);
  store.set("trips", [...all().filter((t) => t.id !== id), { id, v, j }].sort((a, b) => a.j.dep - b.j.dep));
}
const drop = (id) => store.set("trips", all().filter((t) => t.id !== id));

const live = new Map(); // trip index -> /api/trip answer (delays), refreshed with the view
export function initTrips(el, nav) {
  el.innerHTML = `<h2 class="view-title">My trips</h2><div id="t-list"></div>`;
  async function refresh() {
    // finished over two hours ago: gone
    for (const t of all()) if (t.j.arr + (t.j.legs.at(-1).to.delay ?? 0) < Date.now() / 1000 - 7200) drop(t.id);
    const trips = all();
    render(trips);
    await Promise.all([...new Set(trips.flatMap((t) => t.j.legs.map((l) => `${l.i}|${t.v}`)))].map(async (k) => {
      const [i, v] = k.split("|");
      try { live.set(k, await json(`/api/trip/${i}?v=${encodeURIComponent(v)}`)); } catch { live.set(k, null); } // 409: another day's timetable
    }));
    render(all());
  }
  /** Expected time (unix s) at stop k of a leg's train: its arrival (kind 1) or departure (2), live where known. */
  const at = (t, l, k, kind) => {
    const d = live.get(`${l.i}|${t.v}`);
    if (!d) return null;
    return d.base / 1000 + applyDelays(d.stops, d.u).stops[k * 3 + kind];
  };
  function state(t) {
    const j = t.j, nowS = Date.now() / 1000, legs = j.legs;
    if (legs.some((l) => live.get(`${l.i}|${t.v}`)?.c)) return `<span class="very-late">A train of this trip is cancelled</span>`;
    // the next change that may not work any more, by today's times
    for (let k = 1; k < legs.length; k++) {
      const c = j.transfers[k - 1];
      if (c.basis === "seated") continue;
      const arr = at(t, legs[k - 1], legs[k - 1].to.k, 1), dep = at(t, legs[k], legs[k].from.k, 2);
      if (arr === null || dep === null || dep < nowS) continue;
      const left = dep - arr;
      if (left < c.walk) return `<span class="very-late">Change at ${esc(c.at)} at risk: ${mins(Math.max(0, left))} left, ${mins(c.walk)} needed</span>${c.backup ? ` · next: ${esc(c.backup.line)} ${hm(c.backup.dep)}` : ""}`;
    }
    const dep0 = at(t, legs[0], legs[0].from.k, 2) ?? j.dep, arrN = at(t, legs.at(-1), legs.at(-1).to.k, 1) ?? j.arr;
    if (nowS < dep0) return `Leave in ${mins(dep0 - nowS)} · Pl. ${esc(legs[0].from.pl || "?")}`;
    if (nowS > arrN) return "Arrived";
    const on = legs.find((l) => (at(t, l, l.to.k, 1) ?? 0) > nowS) ?? legs.at(-1);
    return `On ${esc(on.line)} ${esc(on.num)} · arrives ${hm(arrN)}`;
  }
  function render(trips) {
    $("t-list").innerHTML = trips.length ? `<ol class="jlist">${trips.map((t) => {
      const j = t.j, l0 = j.legs[0], lN = j.legs.at(-1), d0 = (at(t, l0, l0.from.k, 2) ?? l0.from.sched) - l0.from.sched, d1 = (at(t, lN, lN.to.k, 1) ?? lN.to.sched) - lN.to.sched;
      return `<li class="trip"><div class="jcard">
        <span class="jtimes"><b>${hm(l0.from.sched)}</b>${delayText(d0)}<span class="arrow">→</span><b>${hm(lN.to.sched)}</b>${delayText(d1)}<span class="dur">${esc(l0.from.name)} → ${esc(lN.to.name)}</span></span>
        <span class="jlines">${j.legs.filter((l) => !l.through).map((l) => badge(l.line, l.cat, l.agency)).join('<span class="arrow">›</span>')}</span>
        <span class="jrel">${state(t)}</span>
        <span class="actions"><button data-map="${esc(t.id)}">On the map</button><button data-drop="${esc(t.id)}">Remove</button></span></div></li>`;
    }).join("")}</ol>` : `<div class="empty">Follow a journey from Plan to see it here, live.</div>`;
  }
  $("t-list").addEventListener("click", (e) => {
    const d = e.target.closest("[data-drop]"), m = e.target.closest("[data-map]");
    if (d) { drop(d.dataset.drop); render(all()); }
    if (m) { const t = all().find((x) => x.id === m.dataset.map); if (t) nav.onMap({ v: t.v, legs: t.j.legs.map((l) => ({ i: l.i, num: l.num, from: l.from.k, to: l.to.k })) }); }
  });
  return { refresh };
}
