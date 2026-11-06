// Trip planner: earliest arrival over today's trains (Connection Scan Algorithm), each change rated by how often it
// really works (30 days of recorded times), journeys ranked by when you'll probably arrive, a backup for every change.
import { applyDelays } from "../public/position.js";
import type { Day } from "./gtfs";
import type { Delays } from "./board";
import { db } from "./record";
import { occupancyAll } from "./details";
import { addDays } from "./time";

const LEGS = 5; // at most 4 changes
const DEFAULT_CHANGE = 180; // s, where the feed has no rule for a station
const NONE = 2 ** 31 - 1;

/** Every stop-to-stop hop of every running train under the current delays, by departure; seconds from the day's base. */
type Net = {
  n: number; dep: Int32Array; arr: Int32Array; from: Int32Array; to: Int32Array; trip: Int32Array; k: Int32Array;
  board: Uint8Array; alight: Uint8Array; // 0 where the stop is skipped
  first: Int32Array; last: Int32Array; // per trip: its first and last hop (index into the sorted arrays), -1 if none
  next: Int32Array; // per trip: the trip it continues as (through-running), -1
};

const nets = new WeakMap<object, Net>(); // per delays object: realtime replaces it on every feed (and a new day)
export function network(d: Day, delays: Delays): Net {
  let net = nets.get(delays);
  if (net) return net;
  const hops: number[][] = [];
  d.trips.forEach((t, i) => {
    if (delays[i]?.c) return; // cancelled
    const e = applyDelays(t.stops, delays[i]?.u as any), n = t.stops.length / 3;
    for (let k = 0; k + 1 < n; k++) hops.push([e.stops[k * 3 + 2], e.stops[k * 3 + 4], t.stops[k * 3], t.stops[k * 3 + 3], i, k, e.skipped[k] ? 0 : 1, e.skipped[k + 1] ? 0 : 1]);
  });
  hops.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const n = hops.length, col = (j: number) => Int32Array.from(hops, (h) => h[j]);
  net = { n, dep: col(0), arr: col(1), from: col(2), to: col(3), trip: col(4), k: col(5), board: Uint8Array.from(hops, (h) => h[6]), alight: Uint8Array.from(hops, (h) => h[7]),
    first: new Int32Array(d.trips.length).fill(-1), last: new Int32Array(d.trips.length).fill(-1), next: new Int32Array(d.trips.length).fill(-1) };
  for (let c = 0; c < n; c++) { const t = net.trip[c]; if (net.first[t] < 0) net.first[t] = c; net.last[t] = c; }
  for (let j = 0; j < d.through.length; j += 2) net.next[d.through[j]] = d.through[j + 1];
  nets.set(delays, net);
  return net;
}

// the rules by number (station·1e8 + platform·1e4 + platform), read once per day: the scan asks millions of times
const rules = new WeakMap<Day, { pair: Map<number, number>; station: Map<number, number> }>();
const ruleKey = (st: number, pa: number, pb: number) => st * 1e8 + pa * 1e4 + pb;
/** Minimum change time at station st from platform pa to pb (indexes into d.platforms). */
export function changeTime(d: Day, st: number, pa: number, pb: number) {
  let r = rules.get(d);
  if (!r) {
    const pair = new Map<number, number>(), by = new Map<number, number[]>();
    for (const [k, v] of Object.entries(d.transfers)) { const [s, a, b] = k.split(":").map(Number); pair.set(ruleKey(s, a, b), v); (by.get(s) ?? by.set(s, []).get(s)!).push(v); }
    // the station's typical rule where a pair has none: the median of its platform pairs
    rules.set(d, (r = { pair, station: new Map([...by].map(([s, vs]) => [s, vs.sort((x, y) => x - y)[vs.length >> 1]])) }));
  }
  return r.pair.get(ruleKey(st, pa, pb)) ?? r.pair.get(ruleKey(st, 0, 0)) ?? r.station.get(st) ?? DEFAULT_CHANGE;
}

export type Leg = { trip: number; from: number; to: number; enter: number; exit: number; through?: boolean }; // stop positions on the trip; hops
/**
 * Connection Scan with a bound on legs: earliest arrival at each station with at most L legs, L = 1..LEGS.
 * Returns for each L the journey to `to` (legs in order) or null; t0 in seconds from the day's base.
 */
export function scan(d: Day, net: Net, origin: number, to: number, t0: number): (Leg[] | null)[] {
  const S = d.stations.length, T = d.trips.length;
  const best = Array.from({ length: LEGS + 1 }, () => new Int32Array(S).fill(NONE)), plat = Array.from({ length: LEGS + 1 }, () => new Int32Array(S));
  const jEnter = Array.from({ length: LEGS + 1 }, () => new Int32Array(S).fill(-1)), jExit = Array.from({ length: LEGS + 1 }, () => new Int32Array(S).fill(-1)), jLev = Array.from({ length: LEGS + 1 }, () => new Int8Array(S));
  const enter = Array.from({ length: LEGS + 1 }, () => new Int32Array(T).fill(-1)); // per legs-used L: the hop the trip was boarded at (≤ -2: continued from a hop of the trip before, through-running)
  for (let L = 0; L <= LEGS; L++) best[L][origin] = t0;
  let c = 0;
  for (let lo = 0, hi = net.n; lo < hi;) { const m = (lo + hi) >> 1; net.dep[m] < t0 ? (lo = m + 1) : (hi = m); c = lo; }
  for (; c < net.n; c++) {
    const dep = net.dep[c];
    if (dep > best[LEGS][to]) break; // nothing later can arrive earlier
    const tr = net.trip[c], from = net.from[c], tPlat = d.trips[tr].plat;
    for (let L = 1; L <= LEGS; L++) {
      if (enter[L][tr] === -1 && net.board[c]) {
        const prev = best[L - 1][from];
        if (prev !== NONE && (L === 1 ? from === origin && prev <= dep : prev + changeTime(d, from, plat[L - 1][from], tPlat[net.k[c]]) <= dep)) enter[L][tr] = c;
      }
      if (enter[L][tr] === -1) continue;
      if (net.alight[c] && net.arr[c] < best[L][net.to[c]]) {
        const st = net.to[c];
        for (let M = L; M <= LEGS && net.arr[c] < best[M][st]; M++) { best[M][st] = net.arr[c]; plat[M][st] = tPlat[net.k[c] + 1]; jEnter[M][st] = enter[L][tr]; jExit[M][st] = c; jLev[M][st] = L; }
      }
      if (c === net.last[tr] && net.next[tr] >= 0 && enter[L][net.next[tr]] === -1) enter[L][net.next[tr]] = -2 - c; // stay seated
    }
  }
  return Array.from({ length: LEGS + 1 }, (_, L) => {
    if (!L || best[L][to] === NONE || (L > 1 && best[L][to] >= best[L - 1][to])) return null; // only if more legs make it faster
    const legs: Leg[] = [];
    let st = to, lev = L, guard = 0;
    while (st !== origin && guard++ < 20) {
      let e = jEnter[lev][st], x = jExit[lev][st];
      const L0 = jLev[lev][st];
      for (;;) { // a through-running chain is several legs on one boarding
        const tr = net.trip[x];
        if (e <= -2) { legs.unshift({ trip: tr, from: net.k[net.first[tr]], to: net.k[x] + 1, enter: net.first[tr], exit: x, through: true }); x = -2 - e; e = enter[L0][net.trip[x]]; continue; }
        legs.unshift({ trip: tr, from: net.k[e], to: net.k[x] + 1, enter: e, exit: x });
        st = net.from[e];
        break;
      }
      lev = L0 - 1;
    }
    return st === origin ? legs : null;
  });
}

/** Distinct journeys departing from t0 on: the fastest per number of legs, then again from just after each one's departure. */
export function journeys(d: Day, net: Net, origin: number, to: number, t0: number, want = 6, until = t0 + 4 * 3600, rounds = 12) {
  const out: Leg[][] = [], seen = new Set<string>();
  let t = t0;
  for (let round = 0; round < rounds && out.length < want && t < until; round++) {
    const found = scan(d, net, origin, to, t).filter((j): j is Leg[] => !!j && j.length > 0);
    if (!found.length) break;
    for (const j of found) { const key = j.map((l) => `${l.trip}:${l.from}`).join("|"); if (!seen.has(key)) { seen.add(key); out.push(j); } }
    t = Math.min(...found.map((j) => net.dep[j[0].enter])) + 60;
  }
  return out.sort((a, b) => net.dep[a[0].enter] - net.dep[b[0].enter] || net.arr[a.at(-1)!.exit] - net.arr[b.at(-1)!.exit]);
}

/**
 * How often a change works: arrival delays `a` of the arriving train and departure delays `b` of the departing one
 * (s, same station), `slack` = scheduled departure − scheduled arrival, `walk` = minimum change time.
 * Pairs = [a, b] seen on the same day (a connection that waits for late arrivals shows there); else every a against every b.
 * Nothing recorded: whether today's times leave enough (`left`, as the planner chose the change by them).
 */
export function catchRate(a: number[], b: number[], slack: number, walk: number, pairs: [number, number][] = [], left = slack) {
  if (pairs.length >= 8) return { p: pairs.filter(([x, y]) => x + walk <= slack + y).length / pairs.length, n: pairs.length, basis: "pair" as const };
  if (!a.length) return { p: walk <= left ? 1 : 0, n: 0, basis: "none" as const };
  const bb = b.length ? b : [0];
  let ok = 0;
  for (const x of a) for (const y of bb) if (x + walk <= slack + y) ok++;
  return { p: ok / (a.length * bb.length), n: Math.min(a.length, bb.length), basis: "trains" as const };
}

/** Expected arrival: planned arrival, plus for each change the chance of missing it times what the backup costs. */
export const expectedArrival = (arr: number, changes: { p: number; backupArr: number | null }[]) =>
  arr + changes.reduce((s, c) => s + (1 - c.p) * ((c.backupArr ?? arr + 3600) - arr), 0);

// ---------- recorded delays (30 days of stop_obs) ----------
const memo = new Map<string, { t: number; v: any }>();
const remember = <T,>(key: string, fn: () => T): T => {
  const m = memo.get(key);
  if (m && Date.now() - m.t < 3600_000) return m.v;
  if (memo.size > 5000) memo.clear();
  const v = fn();
  memo.set(key, { t: Date.now(), v });
  return v;
};
type Kind = "arr" | "dep";
/** A train's recorded delays (s) at a station, last 30 days; few records: its line's at that station. `err`: forecast errors instead (real − forecast). */
function samples(d: Day, uic: string, num: string, line: string, kind: Kind, err = false) {
  return remember(`${d.date}|${uic}|${num}|${line}|${kind}|${+err}`, () => {
    const col = err ? `${kind}_delay - ${kind}_fc` : `${kind}_delay`, since = addDays(d.date, -30), ok = `${kind}_delay IS NOT NULL${err ? ` AND ${kind}_fc IS NOT NULL` : ""} AND skipped = 0`;
    const own = (db.query(`SELECT ${col} v FROM stop_obs WHERE train_no = ? AND uic = ? AND date >= ? AND ${ok}`).all(num, uic, since) as { v: number }[]).map((r) => r.v);
    if (own.length >= 5) return { v: own, basis: "train" };
    const lineV = (db.query(`SELECT ${col} v FROM stop_obs WHERE uic = ? AND date >= ? AND line = ? AND ${ok} LIMIT 600`).all(uic, since, line) as { v: number }[]).map((r) => r.v);
    return { v: lineV.length >= 5 ? lineV : own, basis: lineV.length >= 5 ? "line" : "train" };
  });
}
/** The arriving train's arrival and the departing train's departure delay at a station on the days both were recorded. */
const pairsAt = (d: Day, uic: string, a: string, b: string) => remember(`${d.date}|${uic}|${a}>${b}`, () =>
  (db.query(`SELECT x.arr_delay a, y.dep_delay b FROM stop_obs x JOIN stop_obs y ON y.date = x.date AND y.uic = x.uic AND y.train_no = ?
    WHERE x.train_no = ? AND x.uic = ? AND x.date >= ? AND x.arr_delay IS NOT NULL AND y.dep_delay IS NOT NULL AND x.skipped = 0 AND y.skipped = 0`)
    .all(b, a, uic, addDays(d.date, -30)) as { a: number; b: number }[]).map((r) => [r.a, r.b] as [number, number]));

// ---------- the answer ----------
const lineOf = (d: Day, i: number) => d.routes[d.trips[i].route][0] || d.routes[d.trips[i].route][1];
/** Journeys from station uic a to b, departing from `at` (unix s) on, or arriving by it. */
export function plan(d: Day, delays: Delays, a: string, b: string, at: number, arriveBy = false) {
  const origin = d.stations.findIndex((s) => s[3] === a), dest = d.stations.findIndex((s) => s[3] === b);
  if (origin < 0 || dest < 0 || origin === dest) return null;
  const net = network(d, delays), base = d.base / 1000, rel = Math.round(at - base);
  let js: Leg[][];
  if (arriveBy) {
    // the shortest trip there (from far enough back) says where the last departure that can make it is; the window
    // before it widens by 90 min (up to 6 h) until six journeys arrive in time, each window with its own search budget
    const probe = scan(d, net, origin, dest, rel - 14 * 3600).filter((j): j is Leg[] => !!j && j.length > 0);
    const shortest = Math.min(...probe.map((j) => net.arr[j.at(-1)!.exit] - net.dep[j[0].enter]));
    let found: Leg[][] = [];
    for (let back = 5400; Number.isFinite(shortest) && back <= 6 * 3600 && found.length < 6; back += 5400)
      found = journeys(d, net, origin, dest, rel - shortest - back, 60, rel - shortest + 60, 60).filter((j) => net.arr[j.at(-1)!.exit] <= rel);
    js = found.slice(-6);
  } else js = journeys(d, net, origin, dest, rel);
  const occ = occupancyAll();
  const stop = (i: number, k: number, kind: Kind) => {
    const t = d.trips[i], e = applyDelays(t.stops, delays[i]?.u as any), s = d.stations[t.stops[k * 3]], col = kind === "arr" ? 1 : 2;
    return { name: s[0], uic: s[3], k, sched: base + t.stops[k * 3 + col], delay: e.stops[k * 3 + col] - t.stops[k * 3 + col], pl: d.platforms[t.plat[k]] ?? "" };
  };
  const journeysOut = js.map((legs) => {
    const out = legs.map((l) => {
      const t = d.trips[l.trip], [line, cat, agency] = d.routes[t.route], from = stop(l.trip, l.from, "dep");
      return { i: l.trip, line, cat, agency, num: t.num, head: t.head, from, to: stop(l.trip, l.to, "arr"), stops: l.to - l.from - 1, through: l.through ? 1 : 0, occ: occ.get(`${t.agency}:${t.num}`)?.byStop?.[from.uic] ?? null };
    });
    const changes = legs.slice(1).map((l, j) => {
      const A = out[j], B = out[j + 1], st = d.trips[l.trip].stops[l.from * 3];
      if (B.through) return { at: B.from.name, walk: 0, slack: 0, left: 0, p: 1, n: 0, basis: "seated", backup: null };
      const walk = changeTime(d, st, d.trips[legs[j].trip].plat[legs[j].to], d.trips[l.trip].plat[l.from]), slack = B.from.sched - A.to.sched;
      const arrA = A.to.sched + A.to.delay, depB = B.from.sched + B.from.delay, left = depB - arrA; // today's minutes for the change
      // a change within the hour: today's forecasts for both trains, spread by how far such forecasts were off (or by
      // their recorded delays around the median, before enough forecasts are recorded); later: the recorded delays.
      // Both trains on the same footing: the planner chose the change by today's times
      const soon = Math.min(arrA, depB) < Date.now() / 1000 + 3600, live = (i: number) => soon && (delays[i]?.u?.length ?? 0) > 0;
      const around = (i: number, uic: string, num: string, line: string, kind: Kind, now: number) => {
        const err = samples(d, uic, num, line, kind, true).v;
        if (!live(i)) return samples(d, uic, num, line, kind).v;
        if (err.length >= 5) return err.map((x) => now + x);
        const v = samples(d, uic, num, line, kind).v, mid = [...v].sort((x, y) => x - y)[v.length >> 1] ?? 0;
        return v.length ? v.map((x) => now + x - mid) : [now];
      };
      let r;
      if (live(A.i) || live(B.i)) {
        r = { ...catchRate(around(A.i, A.to.uic, A.num, A.line, "arr", A.to.delay), around(B.i, B.from.uic, B.num, B.line, "dep", B.from.delay), slack, walk), basis: "live" };
      } else r = catchRate(samples(d, A.to.uic, A.num, A.line, "arr").v, samples(d, B.from.uic, B.num, B.line, "dep").v, slack, walk, pairsAt(d, A.to.uic, A.num, B.num), left);
      // missed: the next way on from this station, after the train you missed has gone
      const alt = scan(d, net, st, dest, net.dep[l.enter] + 1).filter((x): x is Leg[] => !!x).sort((x, y) => net.arr[x.at(-1)!.exit] - net.arr[y.at(-1)!.exit])[0];
      const backup = alt ? { arr: base + net.arr[alt.at(-1)!.exit], line: lineOf(d, alt[0].trip), num: d.trips[alt[0].trip].num, dep: base + net.dep[alt[0].enter], changes: alt.length - 1 } : null;
      return { at: B.from.name, walk, slack, left, p: Math.round(r.p * 100) / 100, n: r.n, basis: r.basis, backup };
    });
    const arr = base + net.arr[legs.at(-1)!.exit], dep = base + net.dep[legs[0].enter];
    return { dep, arr, exp: Math.round(expectedArrival(arr, changes.map((c) => ({ p: c.p, backupArr: c.backup?.arr ?? null })))), changes: changes.filter((c) => c.basis !== "seated").length, legs: out, transfers: changes };
  });
  return { v: d.version, from: d.stations[origin][0], to: d.stations[dest][0], journeys: journeysOut };
}
