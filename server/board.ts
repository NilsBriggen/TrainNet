// Small answers for the phone views (plan, departures, a train as a list): no need for the whole day timetable.
import { applyDelays } from "../public/position.js";
import type { Day } from "./gtfs";

export type Delays = Record<number, { c?: 1; u?: (number | null)[][]; x?: number }>;

/** Stations with trains today: [name, uic, lon, lat, trains today, daily passengers or 0]. */
export function stationList(d: Day, pax: Map<string, number>) {
  return d.stations.filter((s) => s[4] > 0).map(([name, lon, lat, uic, n]) => [name, uic, lon, lat, n, pax.get(uic) ?? 0]);
}

const stopsAt = new WeakMap<Day, Map<number, [number, number][]>>(); // station -> [trip, stop position], per day
function byStation(d: Day) {
  let m = stopsAt.get(d);
  if (!m) {
    m = new Map();
    d.trips.forEach((t, i) => { for (let p = 0; p < t.stops.length / 3; p++) (m!.get(t.stops[p * 3]) ?? m!.set(t.stops[p * 3], []).get(t.stops[p * 3])!).push([i, p]); });
    stopsAt.set(d, m);
  }
  return m;
}

/** A row about a trip: what the views need to draw its badge and name it. */
const tripHead = (d: Day, i: number) => { const t = d.trips[i], [line, cat, agency] = d.routes[t.route]; return { i, v: d.version, line, cat, agency, num: t.num, head: t.head }; }; // v: trip indexes are per day version

/**
 * The next departures from a station: the ones expected from a minute ago to `span` s ahead, by scheduled time.
 * Each: the trip, scheduled departure (unix s), delay (s), platform, cancelled, not stopping here.
 */
export function board(d: Day, uic: string, delays: Delays, now: number, span = 5400) {
  const st = d.stations.findIndex((s) => s[3] === uic);
  if (st < 0) return null;
  const base = d.base / 1000, out = [];
  for (const [i, p] of byStation(d).get(st) ?? []) {
    const t = d.trips[i];
    if (p === t.stops.length / 3 - 1) continue; // ends here
    const sched = base + t.stops[p * 3 + 2];
    if (sched > now + span || sched < now - 3 * 3600) continue; // cheap reject before applying delays
    const e = applyDelays(t.stops, delays[i]?.u as any), exp = base + e.stops[p * 3 + 2];
    if (exp < now - 60 || exp > now + span) continue;
    out.push({ ...tripHead(d, i), dep: sched, delay: exp - sched, pl: d.platforms[t.plat[p]] ?? "", c: delays[i]?.c ? 1 : 0, skip: e.skipped[p] ? 1 : 0, to: d.stations[t.stops[t.stops.length - 3]][0] });
  }
  out.sort((a, b) => a.dep - b.dep);
  return { v: d.version, station: d.stations[st][0], uic, rows: out.slice(0, 40) };
}

/** One train for a list view: its stops (flat [station, arr, dep], seconds from base, as in /api/day), names, platforms, live updates. */
export function tripInfo(d: Day, i: number, delays: Delays) {
  const t = d.trips[i];
  if (!t) return null;
  const n = t.stops.length / 3;
  return {
    v: d.version, base: d.base, ...tripHead(d, i), hints: t.hints, stops: t.stops,
    names: Array.from({ length: n }, (_, k) => { const s = d.stations[t.stops[k * 3]]; return [s[0], s[3], s[1], s[2]]; }),
    plat: t.plat.map((p) => d.platforms[p] ?? ""), u: delays[i]?.u ?? [], c: delays[i]?.c ?? 0, x: delays[i]?.x ?? 0,
  };
}
