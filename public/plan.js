// Plan: journeys ranked by when you'll probably arrive, each change with how often it really works and what happens if not.
import { routeStyle } from "./colors.js";
import { $, badge, delayText, esc, hm, json, meters, mins, stationPicker, stations, store, toast } from "./ui.js";
import { isFollowed, saveTrip } from "./trips.js";

const NEAR = `<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="5.2" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="10" cy="10" r="1.9" fill="currentColor"/><path d="M10 1.8v2.6M10 15.6v2.6M1.8 10h2.6M15.6 10h2.6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>`;
const pct = (p) => `${Math.round(p * 100)} %`;
const tone = (p) => (p >= 0.9 ? "ok" : p >= 0.7 ? "late" : "very-late");
const BASIS = { pair: (n) => `on ${n} recorded days with both trains`, trains: () => "from both trains' last 30 days", live: () => "from today's forecast", none: () => "not recorded yet" };
/** "2025-11-06T09:31" in the phone's own time, for a datetime-local field. */
const local = (unix) => { const d = new Date(unix * 1000); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };

export function initPlan(el, nav) {
  el.innerHTML = `<h2 class="view-title">Plan a trip</h2>
    <form class="plan-form" autocomplete="off">
      <div class="field"><label for="p-from">From</label><input id="p-from" type="search" placeholder="Station" spellcheck="false" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="p-from-list">
        <button type="button" id="p-near" class="icon" title="Nearest station" aria-label="From the nearest station">${NEAR}</button><ul id="p-from-list" class="picks" role="listbox" hidden></ul></div>
      <button type="button" id="p-swap" class="icon swap" title="Swap" aria-label="Swap from and to"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M6 3v13M6 16l-3-3M6 16l3-3M14 17V4M14 4l-3 3M14 4l3 3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
      <div class="field"><label for="p-to">To</label><input id="p-to" type="search" placeholder="Station" spellcheck="false" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="p-to-list"><ul id="p-to-list" class="picks" role="listbox" hidden></ul></div>
      <div class="when"><select id="p-mode" aria-label="Depart or arrive"><option value="dep">Depart</option><option value="arr">Arrive by</option></select>
        <input id="p-time" type="datetime-local" aria-label="Time"><button type="button" id="p-now" class="chip-btn" aria-pressed="true">Now</button></div>
    </form>
    <div id="p-recent" class="recent"></div>
    <div id="p-out" aria-live="polite"></div>`;
  let from = null, to = null, now = true, last = null, open = -1, seq = 0;
  const fromP = stationPicker($("p-from"), $("p-from-list"), $("p-near"), (s) => { from = s; run(); });
  const toP = stationPicker($("p-to"), $("p-to-list"), null, (s) => { to = s; run(); });
  const time = $("p-time"), mode = $("p-mode");
  const setNow = (on) => { now = on; $("p-now").setAttribute("aria-pressed", String(on)); if (on) time.value = local(Date.now() / 1000); };
  setNow(true);
  $("p-now").onclick = () => { setNow(true); run(); };
  time.onchange = () => { now = false; $("p-now").setAttribute("aria-pressed", "false"); run(); };
  mode.onchange = () => run();
  $("p-swap").onclick = () => { [from, to] = [to, from]; fromP.set(from); toP.set(to); run(); };
  el.querySelector("form").onsubmit = (e) => { e.preventDefault(); run(); };

  const recent = () => {
    const list = store.get("recent", []);
    stations().then((st) => {
      const items = list.map(([a, b]) => [st.byUic.get(a), st.byUic.get(b)]).filter(([a, b]) => a && b);
      $("p-recent").innerHTML = items.length && !last ? `<h3>Recent</h3>${items.map(([a, b], k) => `<button class="stn" data-r="${k}">${esc(a[0])} → ${esc(b[0])}</button>`).join("")}` : "";
      $("p-recent").onclick = (e) => { const b = e.target.closest("[data-r]"); if (b) { [from, to] = items[+b.dataset.r]; fromP.set(from); toP.set(to); run(); } };
    });
  };
  recent();

  async function run(at) {
    if (!from || !to || from[1] === to[1]) return;
    store.set("recent", [[from[1], to[1]], ...store.get("recent", []).filter(([a, b]) => a !== from[1] || b !== to[1])].slice(0, 6));
    if (now) time.value = local(Date.now() / 1000);
    const t = at ?? Math.floor(new Date(time.value).getTime() / 60000) * 60, arrive = !at && mode.value === "arr", my = ++seq;
    if (!at) { open = -1; $("p-out").innerHTML = `<div class="empty">Finding journeys…</div>`; }
    try {
      const r = await json(`/api/plan?from=${from[1]}&to=${to[1]}&at=${t}${arrive ? "&arrive=1" : ""}`);
      if (my !== seq) return; // a newer search started meanwhile
      last = at && last ? { ...r, journeys: [...last.journeys, ...r.journeys.filter((j) => !last.journeys.some((x) => same(x, j)))] } : r;
      $("p-recent").innerHTML = "";
      render();
    } catch { if (my === seq) $("p-out").innerHTML = `<div class="empty">Couldn't plan this trip. Try again in a moment.</div>`; }
  }
  const same = (a, b) => a.legs.map((l) => `${l.i}:${l.from.k}`).join() === b.legs.map((l) => `${l.i}:${l.from.k}`).join();

  function render() {
    const out = $("p-out");
    el.classList.toggle("detail", open >= 0); // an opened journey has the screen to itself
    if (!last.journeys.length) return void (out.innerHTML = `<div class="empty">No train connection found in the next hours.</div>`);
    if (open >= 0) return void (out.innerHTML = journeyHtml(last.journeys[open], last.v));
    const best = Math.min(...last.journeys.map((j) => j.exp));
    out.innerHTML = `<ol class="jlist">${last.journeys.map((j, k) => cardHtml(j, k, j.exp === best)).join("")}</ol><button class="more-btn" data-later>Later</button>`;
  }

  function cardHtml(j, k, best) {
    const d0 = j.legs[0].from.delay, d1 = j.legs.at(-1).to.delay, risky = j.transfers.filter((c) => c.basis !== "seated").sort((a, b) => a.p - b.p)[0];
    return `<li><button class="jcard" data-j="${k}">
      <span class="jtimes"><b>${hm(j.legs[0].from.sched)}</b>${delayText(d0)}<span class="arrow">→</span><b>${hm(j.legs.at(-1).to.sched)}</b>${delayText(d1)}<span class="dur">${mins(j.arr - j.dep)}</span></span>
      <span class="jlines">${j.legs.filter((l) => !l.through).map((l) => badge(l.line, l.cat, l.agency)).join('<span class="arrow">›</span>')}<span class="jch">${j.changes ? `${j.changes} change${j.changes > 1 ? "s" : ""}` : "direct"}</span>${meters(j.legs[0].occ)}</span>
      ${risky ? `<span class="jrel ${tone(risky.p)}">Change at ${esc(risky.at)} · ${mins(risky.slack)} · works ${pct(risky.p)}</span>` : ""}
      ${j.exp - j.arr >= 60 ? `<span class="jexp">probably ${hm(j.exp)}</span>` : best ? `<span class="jexp ok">earliest likely arrival</span>` : ""}
    </button></li>`;
  }

  function journeyHtml(j, v) {
    const parts = [];
    j.legs.forEach((l, k) => {
      if (k) {
        const c = j.transfers[k - 1];
        parts.push(c.basis === "seated" ? `<li class="change seated">Stay seated: continues as ${esc(l.line)} ${esc(l.num)}</li>`
          : `<li class="change ${tone(c.p)}"><b>Change at ${esc(c.at)}</b> · ${mins(c.slack)}, ${mins(c.walk)} needed<br>works ${pct(c.p)} <small>${BASIS[c.basis]?.(c.n) ?? ""}</small>
            ${c.backup && c.p < 0.97 ? `<div class="backup">If missed: ${esc(c.backup.line)} ${esc(c.backup.num)} at ${hm(c.backup.dep)}, arriving ${hm(c.backup.arr)} (+${mins(c.backup.arr - j.arr)})</div>` : ""}</li>`);
      }
      parts.push(`<li class="leg" style="--line:${routeStyle(l.line || l.cat, l.cat, l.agency).c}">
        <div class="leg-h">${badge(l.line, l.cat, l.agency)} <span>${esc(l.num)} → ${esc(l.head)}</span>${meters(l.occ)}</div>
        <div class="leg-row"><span class="t">${hm(l.from.sched)} ${delayText(l.from.delay)}</span><span class="s">${esc(l.from.name)}</span><span class="pl">${l.from.pl ? `Pl. ${esc(l.from.pl)}` : ""}</span></div>
        <button class="leg-stops" data-train="${k}">${l.stops ? `${l.stops} stop${l.stops > 1 ? "s" : ""} · ` : ""}the train's stops ›</button>
        <div class="leg-row"><span class="t">${hm(l.to.sched)} ${delayText(l.to.delay)}</span><span class="s">${esc(l.to.name)}</span><span class="pl">${l.to.pl ? `Pl. ${esc(l.to.pl)}` : ""}</span></div></li>`);
    });
    const followed = isFollowed(j, v);
    return `<button class="back" data-back>‹ Journeys</button>
      <div class="jsum"><b>${hm(j.legs[0].from.sched)} → ${hm(j.legs.at(-1).to.sched)}</b> · ${mins(j.arr - j.dep)} · ${j.changes ? `${j.changes} change${j.changes > 1 ? "s" : ""}` : "direct"}${j.exp - j.arr >= 60 ? ` · <span class="late">probably ${hm(j.exp)}</span>` : ""}</div>
      <div class="actions"><button data-follow aria-pressed="${followed}">${followed ? "Following" : "Follow"}</button><button data-onmap>On the map</button></div>
      <ol class="legs">${parts.join("")}</ol>`;
  }

  $("p-out").addEventListener("click", (e) => {
    const card = e.target.closest("[data-j]");
    if (card) {
      open = +card.dataset.j; render(); el.closest("#views")?.scrollTo(0, 0);
      nav.detail(() => { open = -1; render(); });
      const j = last.journeys[open];
      if (!nav.phone) nav.onMap({ v: last.v, legs: j.legs.map((l) => ({ i: l.i, num: l.num, from: l.from.k, to: l.to.k })) }); // beside the map: drawn at once
      return;
    }
    if (e.target.closest("[data-later]")) return void run(last.journeys.at(-1).dep + 60);
    if (e.target.closest("[data-back]")) return void nav.back();
    const j = last?.journeys[open];
    if (!j) return;
    const tr = e.target.closest("[data-train]");
    if (tr) { const l = j.legs[+tr.dataset.train]; return void nav.openTrain({ ...l, v: last.v }); }
    if (e.target.closest("[data-onmap]")) return void nav.onMap({ v: last.v, legs: j.legs.map((l) => ({ i: l.i, num: l.num, from: l.from.k, to: l.to.k })) });
    if (e.target.closest("[data-follow]")) { saveTrip(j, last.v); toast("Saved to My trips"); render(); }
  });
  return { refresh: () => { if (now && last && open < 0) run(); } };
}
