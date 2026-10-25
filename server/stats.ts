// /api/stats/*: computed from the current day, the live realtime state and the history database; cached briefly.
import { applyDelays, locate } from "../public/position.js";
import { db, lineKeysOf, lineOf } from "./record";
import { ambiguousLabels, lineName } from "./lines";
import { current } from "./realtime";
import { occupancyAll, TYPE_INFO, typeName, wikiOf } from "./details";
import { addDays, zurichDate } from "./time";
import { dist } from "./paths";
import type { Day } from "./gtfs";

const LONG = /^(IC|ICE|ICN|EC|EN|NJ|TGV|RJ|RJX)$/;
/** Same categories as the map's chips. */
const catOfRow = (cat: string, agency: string) =>
  LONG.test(cat) ? "Long distance" : cat === "IR" ? "InterRegio" : cat === "RE" ? "RegioExpress" : cat === "S" || cat === "SN" ? "S-Bahn" : cat === "PE" ? "Panorama" : agency === "11" ? "Regional" : "Private";
export const category = (d: Day, route: number) => catOfRow(d.routes[route][1], d.routes[route][2]);

const zfmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Zurich", hour: "numeric", hourCycle: "h23", weekday: "short" });
const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const zurich = (epoch: number) => {
  const p = Object.fromEntries(zfmt.formatToParts(new Date(epoch * 1000)).map((x) => [x.type, x.value]));
  return { hour: +p.hour, dow: DOW.indexOf(p.weekday) };
};

const cache = new Map<string, { t: number; v: unknown }>();
function cached<T>(key: string, ttlSec: number, fn: () => T): T {
  const hit = cache.get(key);
  cache.delete(key); // re-inserted below: the map's order is least recently used first
  if (hit && Date.now() - hit.t < ttlSec * 1000) return cache.set(key, hit), hit.v as T;
  const v = fn();
  cache.set(key, { t: Date.now(), v });
  if (cache.size > 500) cache.delete(cache.keys().next().value!);
  return v;
}

const all = (sql: string, ...p: any[]) => db.query(sql).all(...p) as any[];
const one = (sql: string, ...p: any[]) => db.query(sql).get(...p) as any;
const pct = (ok: number, n: number) => (n ? Math.round((1000 * ok) / n) / 10 : null);
/** Share of a recorded day's trains that had live data: a day recorded only partly (restarts, the first evening) isn't typical. */
const covered = (r: { trips: number; observed: number }) => (r.trips ? Math.round((100 * r.observed) / r.trips) : 0);
const COVERED = 60;
const nameOfUic = (d: Day) => cached(`uic:${d.version}`, 86400, () => new Map(d.stations.map((s, i) => [s[3], i])));
const station = (d: Day, uic: string) => { const i = nameOfUic(d).get(uic); return i === undefined ? null : { i, name: d.stations[i][0], uic, lon: d.stations[i][1], lat: d.stations[i][2] }; };

/** Where every trip (or those passing `only`) is now, by the live delays. */
function nowState(d: Day, only?: (t: Day["trips"][number]) => boolean) {
  const { delays } = current(), t = Date.now() / 1000 - d.base / 1000;
  return d.trips.flatMap((trip, i) => {
    if (only && !only(trip)) return [];
    const e = applyDelays(trip.stops, delays[i]?.u), p = locate(e.stops, t);
    return [{ i, trip, e, p, c: !!delays[i]?.c, x: delays[i]?.x ?? 0, rt: !!delays[i]?.u }];
  });
}

// ---------- overview ----------
function live(d: Day) {
  const { alerts } = current(), t = Date.now() / 1000 - d.base / 1000;
  let running = 0, observed = 0, late = 0, cancelled = 0, stuck = 0, km = 0, kmRate = 0;
  const byCat: Record<string, number> = {}, buckets = [0, 0, 0, 0, 0, 0, 0];
  const edges = [60, 180, 300, 600, 1200, 1800]; // <1, 1–3, 3–5, 5–10, 10–20, 20–30, 30+ min
  for (const { trip, e, p, c, x, rt } of nowState(d)) {
    const last = trip.stops.length / 3 - 1;
    if (trip.date === d.date && !c) { // train-km of today's service day
      if (t >= e.stops[last * 3 + 1]) km += trip.km[last];
      else if (p) {
        const seg = trip.km[p.b] - trip.km[p.a], dur = e.stops[p.b * 3 + 1] - e.stops[p.a * 3 + 2];
        km += trip.km[p.a] + (p.at ? 0 : p.f * seg);
        if (!p.at && dur > 0) kmRate += seg / dur;
      }
    }
    if (!p) continue;
    if (c) { cancelled++; continue; } // drawn faintly on the map, but not running
    running++;
    const dl = e.delay[p.b], cat = category(d, trip.route);
    byCat[cat] = (byCat[cat] ?? 0) + 1;
    if (!rt) continue; // no realtime: unknown, not on time (same rule as the map and the sparkline)
    observed++;
    if (dl >= 180) late++;
    if (x) stuck++;
    buckets[edges.findIndex((b) => dl < b) === -1 ? 6 : edges.findIndex((b) => dl < b)]++;
  }
  return {
    running, observed, late, cancelled, stuck, km: Math.round(km), kmRate, punctual: pct(observed - late, observed),
    byCat: Object.entries(byCat).map(([cat, n]) => ({ cat, n })).sort((a, b) => b.n - a.n),
    delayHist: ["< 1", "1–3", "3–5", "5–10", "10–20", "20–30", "30+"].map((bucket, k) => ({ bucket, n: buckets[k] })),
    incidents: alerts.filter((a) => a.sudden).length,
    alerts: [1, 2, 3].map((sev) => alerts.filter((a) => a.sev === sev).length),
  };
}

function today(d: Day) {
  const date = d.date, base = d.base / 1000;
  const tot = one(`SELECT count(*) trips, sum(observed) observed, sum(observed AND NOT cancelled AND final_delay < 180) punctual,
    sum(cancelled) cancelled, round(sum(km * (1 - cancelled))) km, avg(CASE WHEN observed AND NOT cancelled THEN final_delay END) avg_delay FROM trip_day WHERE date = ?`, date);
  const P = `sum(observed AND NOT cancelled) obs, sum(observed AND NOT cancelled AND final_delay < 180) ok`;
  const cats = new Map<string, { cat: string; obs: number; ok: number }>();
  for (const r of all(`SELECT cat, agency, ${P} FROM trip_day WHERE date = ? GROUP BY cat, agency`, date)) {
    const c = catOfRow(r.cat, r.agency), x = cats.get(c) ?? { cat: c, obs: 0, ok: 0 };
    x.obs += r.obs; x.ok += r.ok;
    cats.set(c, x);
  }
  const hours = new Map<number, { obs: number; ok: number }>();
  for (const r of all(`SELECT (arr - ?) / 3600 h, ${P} FROM trip_day WHERE date = ? GROUP BY h`, base, date)) {
    const h = Math.floor(r.h) % 24, x = hours.get(h) ?? { obs: 0, ok: 0 };
    x.obs += r.obs; x.ok += r.ok;
    hours.set(h, x);
  }
  const hot = all(`SELECT a.uic ua, b.uic ub, count(*) n, avg(b.arr_delay - a.dep_delay) gain FROM stop_obs a
    JOIN stop_obs b ON b.date = a.date AND b.trip = a.trip AND b.idx = a.idx + 1
    WHERE a.date = ? AND a.dep_delay IS NOT NULL AND b.arr_delay IS NOT NULL GROUP BY ua, ub HAVING n >= 5 ORDER BY gain DESC LIMIT 60`, date);
  return {
    ...tot, punctualPct: pct(tot.punctual, tot.observed - (tot.cancelled ?? 0)),
    byCat: [...cats.values()].map((x) => ({ ...x, pct: pct(x.ok, x.obs) })).sort((a, b) => b.obs - a.obs),
    byOperator: all(`SELECT agency, count(*) trips, ${P} FROM trip_day WHERE date = ? GROUP BY agency ORDER BY trips DESC LIMIT 12`, date)
      .map((r) => ({ name: d.agencies[r.agency] ?? r.agency, trips: r.trips, pct: pct(r.ok, r.obs) })),
    byLine: all(`SELECT line, count(*) trips, ${P} FROM trip_day WHERE date = ? GROUP BY line HAVING obs >= 4 ORDER BY obs DESC LIMIT 30`, date)
      .map((r) => ({ line: r.line, trips: r.trips, pct: pct(r.ok, r.obs) })),
    byHour: [...hours].sort((a, b) => a[0] - b[0]).map(([hour, x]) => ({ hour, pct: pct(x.ok, x.obs), n: x.obs })),
    worst: all(`SELECT train_no, line, origin, dest, final_delay, arr FROM trip_day WHERE date = ? AND observed AND NOT cancelled ORDER BY final_delay DESC LIMIT 12`, date),
    stationsLate: all(`SELECT uic, count(dep_delay) n, avg(dep_delay) avg FROM stop_obs WHERE date = ? AND dep_delay IS NOT NULL AND skipped = 0 GROUP BY uic HAVING n >= 30 ORDER BY avg DESC LIMIT 12`, date)
      .map((r) => ({ ...station(d, r.uic), n: r.n, avg: r.avg })),
    hotspots: hot.map((r) => ({ a: station(d, r.ua), b: station(d, r.ub), n: r.n, gain: r.gain })).filter((r) => r.a && r.b),
    cancelledByLine: all(`SELECT line, sum(cancelled) n FROM trip_day WHERE date = ? GROUP BY line HAVING n > 0 ORDER BY n DESC LIMIT 12`, date),
    incidents: all(`SELECT id, kind, cause, sev_max, sudden, since, first_seen, last_seen, h, why, d FROM alert_log WHERE last_seen >= ? AND sev_max >= 2 ORDER BY coalesce(since, first_seen)`, base),
  };
}

/** Static per timetable day. */
function facts(d: Day) {
  return cached(`facts:${d.version}`, 86400, () => {
    // every trip stops in Switzerland (loadDay drops the others), but cross-border ones also have foreign stops and sections
    const swiss = (st: number) => d.stations[st][3].startsWith("85");
    const trips = d.trips.filter((t) => t.date === d.date);
    const seg = new Map<string, { a: number; b: number; n: number; km: number; sane: boolean; best?: any }>();
    const ops = new Map<string, number>(), plats = new Map<number, Set<number>>();
    let km = 0, night = 0;
    const deps: number[] = [];
    for (const t of trips) {
      const s = t.stops, n = s.length / 3, line = lineOf(d, t.route);
      km += t.km[n - 1];
      for (let k = 0; k < n - 1; k++) if (swiss(s[k * 3])) deps.push(s[k * 3 + 2] % 86400);
      if (/^(NJ|EN)$/.test(d.routes[t.route][1]) || (s[2] % 86400 >= 3600 && s[2] % 86400 < 4 * 3600)) night++;
      ops.set(t.agency, (ops.get(t.agency) ?? 0) + 1);
      for (let k = 0; k < n; k++) if (t.plat[k]) (plats.get(s[k * 3]) ?? plats.set(s[k * 3], new Set()).get(s[k * 3])!).add(t.plat[k]);
      for (let k = 1; k < n; k++) {
        const a = s[(k - 1) * 3], b = s[k * 3], key = a < b ? `${a}-${b}` : `${b}-${a}`;
        const crow = dist(d.stations[a][1], d.stations[a][2], d.stations[b][1], d.stations[b][2]) / 1000;
        // a routing detour inflates km (and so speed): records only count sections whose track is ≤ 1.4× the straight line
        const x = seg.get(key) ?? { a, b, n: 0, km: t.km[k] - t.km[k - 1], sane: t.km[k] - t.km[k - 1] <= 1.4 * crow + 0.5 };
        x.n++;
        const dur = s[k * 3 + 1] - s[(k - 1) * 3 + 2], kmh = dur > 0 ? x.km / (dur / 3600) : 0;
        if (x.sane && swiss(a) && swiss(b) && x.km >= 8 && dur >= 180 && kmh < 330 && (!x.best || kmh > x.best.kmh)) x.best = { kmh, train: `${line} ${t.num}`, minutes: dur / 60 };
        seg.set(key, x);
      }
    }
    const name = (i: number) => d.stations[i][0], segs = [...seg.values()];
    // the night break is the longest gap between departures around the clock: the first and last train sit on either side of it
    deps.sort((a, b) => a - b);
    let gap = deps.length ? deps[0] + 86400 - deps.at(-1)! : 0, first = deps[0] ?? 0, lastDep = deps.at(-1) ?? 0;
    for (let k = 1; k < deps.length; k++) if (deps[k] - deps[k - 1] > gap) { gap = deps[k] - deps[k - 1]; first = deps[k]; lastDep = deps[k - 1]; }
    const hm = (sec: number) => `${String(Math.floor(sec / 3600) % 24).padStart(2, "0")}:${String(Math.floor(sec / 60) % 60).padStart(2, "0")}`;
    const byNum = new Map<string, typeof trips[number]>();
    for (const t of trips) if (!byNum.has(t.num) || t.km.at(-1)! > byNum.get(t.num)!.km.at(-1)!) byNum.set(t.num, t);
    return {
      trips: trips.length, km: Math.round(km), stations: d.stations.filter((s) => s[4] > 0).length, operators: ops.size, night,
      first: hm(first), last: hm(lastDep), allNight: gap < 1800, // weekend nights: night trains, no break
      busiestStations: d.stations.filter((s) => s[3].startsWith("85")).map((s) => ({ name: s[0], uic: s[3], n: s[4] })).sort((a, b) => b.n - a.n).slice(0, 12),
      busiestSegments: segs.filter((x) => swiss(x.a) && swiss(x.b)).sort((x, y) => y.n - x.n).slice(0, 12).map((x) => ({ from: name(x.a), to: name(x.b), n: x.n })),
      fastest: segs.filter((x) => x.best).sort((x, y) => y.best.kmh - x.best.kmh).slice(0, 12)
        .map((x) => ({ from: name(x.a), to: name(x.b), km: Math.round(x.km * 10) / 10, kmh: Math.round(x.best.kmh), train: x.best.train, minutes: Math.round(x.best.minutes) })),
      longestNonstop: segs.filter((x) => x.sane && (swiss(x.a) || swiss(x.b))).sort((x, y) => y.km - x.km).slice(0, 10).map((x) => ({ from: name(x.a), to: name(x.b), km: Math.round(x.km) })),
      longestTrips: [...byNum.values()].sort((x, y) => y.km.at(-1)! - x.km.at(-1)!).slice(0, 10).map((t) => ({
        train: `${lineOf(d, t.route)} ${t.num}`, num: t.num, from: name(t.stops[0]), to: name(t.stops[t.stops.length - 3]), km: Math.round(t.km.at(-1)!),
        hours: Math.round(((t.stops[t.stops.length - 2] - t.stops[2]) / 3600) * 10) / 10,
      })),
      operatorsByTrips: [...ops].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([a, n]) => ({ name: d.agencies[a] ?? a, n })),
      mostPlatforms: [...plats].sort((a, b) => b[1].size - a[1].size).slice(0, 10).map(([i, p]) => ({ name: name(i), uic: d.stations[i][3], n: p.size })),
    };
  });
}

function crowding(d: Day) {
  return cached(`crowd:${d.version}`, 600, () => {
    const lineByNum = new Map(d.trips.map((t) => [`${t.agency}:${t.num}`, lineOf(d, t.route)]));
    const rows = [...occupancyAll()].map(([k, v]) => ({
      num: k.split(":")[1], line: lineByNum.get(k) ?? "", full: v.sec.filter((s) => s[2] === 3).length, busy: v.sec.filter((s) => s[2] === 2).length, sections: v.sec.length,
    }));
    const hours = Array.from({ length: 24 }, () => [0, 0]);
    for (const v of occupancyAll().values()) for (const [time, , l2] of v.sec) if (l2) { const h = +time.slice(0, 2) % 24; hours[h][0] += l2; hours[h][1]++; }
    return {
      mostCrowded: rows.filter((r) => r.full || r.busy).sort((a, b) => b.full - a.full || b.busy - a.busy).slice(0, 15),
      byHour: hours.map(([sum, n], hour) => ({ hour, level: n ? sum / n : null })).filter((h) => h.level !== null),
    };
  });
}

function history() {
  return cached("history", 1800, () => { // the heatmap scans 30 days of stop_obs
    const cutoff = addDays(zurichDate(new Date()), -30);
    const heat = new Map<string, { dow: number; hour: number; n: number; sum: number; late: number }>();
    for (const r of all(`SELECT sched_dep / 3600 h, count(*) n, sum(dep_delay) s, sum(dep_delay >= 180) late FROM stop_obs
      WHERE date >= ? AND sched_dep IS NOT NULL AND dep_delay IS NOT NULL AND skipped = 0 GROUP BY h`, cutoff)) {
      const { hour, dow } = zurich(Math.floor(r.h) * 3600), k = `${dow}:${hour}`, x = heat.get(k) ?? { dow, hour, n: 0, sum: 0, late: 0 };
      x.n += r.n; x.sum += r.s; x.late += r.late;
      heat.set(k, x);
    }
    return {
      days: all(`SELECT date, trips, observed, punctual, cancelled, km, avg_delay, p90_delay FROM agg_net_day ORDER BY date`)
        .map((r) => ({ ...r, pct: pct(r.punctual, r.observed - r.cancelled), coverage: covered(r) })),
      heat: [...heat.values()].map((x) => ({ dow: DOW[x.dow], hour: x.hour, avg: x.sum / x.n / 60, late: pct(x.late, x.n), n: x.n })),
      incidentsByWeek: byWeek(all(`SELECT first_seen, kind FROM alert_log WHERE sev_max >= 2 ORDER BY first_seen`)),
    };
  });
}

/** Monday of the Zurich week, so an incident early on Monday morning isn't counted in the week before (UTC). */
function byWeek(rows: { first_seen: number; kind: string }[]) {
  const n = new Map<string, number>();
  for (const r of rows) {
    const date = zurichDate(new Date(r.first_seen * 1000)), week = addDays(date, -((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7));
    n.set(`${week}|${r.kind}`, (n.get(`${week}|${r.kind}`) ?? 0) + 1);
  }
  return [...n].map(([k, count]) => { const [week, kind] = k.split("|"); return { week, kind, n: count }; });
}

/** Punctuality on the same weekday over the last 8 weeks of official data: "today vs a typical Saturday". */
function typical(d: Day) {
  return cached(`typical:${d.date}`, 3600, () => {
    const dow = new Date(`${d.date}T12:00:00Z`).getUTCDay(), dates = Array.from({ length: 8 }, (_, k) => addDays(d.date, -7 * (k + 1)));
    const r = one(`SELECT count(*) days, sum(punctual) ok, sum(observed) n, avg(trips) trips FROM hist_net_day WHERE date IN (${dates.map(() => "?").join(",")})`, ...dates);
    return r.days ? { weekday: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][dow], days: r.days, pct: pct(r.ok, r.n), trips: Math.round(r.trips) } : null;
  });
}

export const overview = (d: Day) => cached(`overview:${d.version}`, 20, () => ({
  date: d.date, feedTime: current().feedTime, live: live(d), facts: facts(d), today: today(d), crowding: crowding(d), history: history(), typical: typical(d),
  series: all(`SELECT t, running, late, cancelled, stuck, observed FROM net_sample WHERE t >= ? GROUP BY t / 60 ORDER BY t`, d.base / 1000), // one per minute
}));

// ---------- history since 2018 (official actual data) ----------
export function longHistory() {
  const v = one("SELECT count(*) n, max(date) d FROM hist_net_day"); // a newly imported day (or a rebuild) shows at once
  return cached(`long:${v.n}:${v.d}`, 3600, () => { // cheap: a few thousand daily rows
    const days = all(`SELECT date, trips, observed, punctual, cancelled, extra, sum_final_delay FROM hist_net_day ORDER BY date`);
    if (!days.length) return null;
    // a day with under half the trains of the days around it is a gap in the archive (1–16 July 2019 are placeholder
    // files): kept in the ratios, left out of per-day figures. ±45 days, so a gap of two weeks can't be its own median.
    days.forEach((r, i) => {
      const near = days.slice(Math.max(0, i - 45), i + 46).map((x) => x.trips).sort((a, b) => a - b);
      r.partial = r.trips < near[near.length >> 1] / 2;
    });
    const sum = (rows: any[], k: string) => rows.reduce((a, r) => a + r[k], 0);
    const group = (len: number) => [...d3group(days, (r) => r.date.slice(0, len))].map(([key, rows]) => {
      const whole = rows.filter((r) => !r.partial), observed = sum(rows, "observed"), trips = sum(rows, "trips");
      return { key, days: rows.length, missing: rows.length - whole.length, perDay: whole.length ? Math.round(sum(whole, "trips") / whole.length) : null,
        pct: pct(sum(rows, "punctual"), observed), cancelled: sum(rows, "cancelled"), extra: sum(rows, "extra"), cancelledPct: pct(sum(rows, "cancelled"), trips),
        cancelledPerDay: whole.length ? Math.round(sum(whole, "cancelled") / whole.length) : null, extraPerDay: whole.length ? Math.round(sum(whole, "extra") / whole.length) : null,
        avgDelay: observed ? sum(rows, "sum_final_delay") / observed : null }; // early counts as 0
    });
    const months = group(7).map(({ key, ...m }) => ({ month: key, ...m })), years = group(4).map(({ key, ...y }) => ({ year: key, ...y }));
    // lines: only those with real traffic in a year, so a line with three trains doesn't top the list; "EC|" etc. are categories, no lines
    const lineYears = all(`SELECT substr(month, 1, 4) year, line, sum(trips) trips, sum(punctual) ok, sum(observed) n FROM hist_line_month
      WHERE line NOT LIKE '%|' GROUP BY year, line HAVING n >= 3000`).map((r) => ({ year: r.year, line: r.line, trips: r.trips, pct: pct(r.ok, r.n) }));
    const byYear = d3group(lineYears, (r) => r.year);
    return {
      first: days[0].date, last: days.at(-1).date, days: days.length, missing: days.filter((r) => r.partial).length, movers: movers(months),
      months, years, calendar: days.map((r) => [r.date, pct(r.punctual, r.observed), r.trips, r.partial ? 1 : 0]),
      season: all(`SELECT CAST(substr(month, 6, 2) AS INTEGER) m, hour, sum(late) late, sum(n) n FROM hist_hour_month GROUP BY m, hour HAVING n >= 500`)
        .map((r) => ({ month: r.m, hour: r.hour, late: pct(r.late, r.n) })),
      lines: [...byYear].sort((a, b) => b[0].localeCompare(a[0])).map(([year, rows]) => {
        const sorted = rows.sort((a, b) => a.pct - b.pct);
        return { year, worst: sorted.slice(0, 5), best: sorted.slice(-5).reverse() };
      }),
    };
  });
}
/**
 * Year to date against the same months a year earlier: the lines and stations that changed most. Complete months only,
 * and only what ran at least 1,000 times in both periods, so a few trains can't top the list.
 */
function movers(months: { month: string; days: number }[]) {
  const done = months.filter((m) => m.days >= 28), last = done.at(-1)?.month;
  if (!last) return null;
  const year = last.slice(0, 4), now = done.filter((m) => m.month.startsWith(year)).map((m) => m.month);
  const before = now.map((m) => `${+year - 1}${m.slice(4)}`);
  if (!now.length || !months.some((m) => m.month === before[0])) return null;
  const q = (sql: string, ms: string[]) => new Map(all(sql.replace("$M", ms.map(() => "?").join(",")), ...ms).map((r) => [r.k, r]));
  const compare = (sql: string, name?: (k: string, r: any) => string) => {
    const a = q(sql, now), b = q(sql, before), rows: any[] = [];
    for (const [k, x] of a) {
      const y = b.get(k);
      if (!y || x.n < 1000 || y.n < 1000) continue;
      rows.push({ key: k, name: name ? name(k, x) : k, now: pct(x.ok, x.n), before: pct(y.ok, y.n), n: x.n, delta: Math.round((1000 * x.ok) / x.n - (1000 * y.ok) / y.n) / 10 });
    }
    rows.sort((x, y) => y.delta - x.delta);
    return { up: rows.slice(0, 10), down: rows.slice(-10).reverse() };
  };
  return {
    period: `${now[0].slice(5)}–${now.at(-1)!.slice(5)}`, year, lines: compare(`SELECT line k, sum(punctual) ok, sum(observed) n FROM hist_line_month WHERE month IN ($M) AND line NOT LIKE '%|' GROUP BY line`),
    stations: compare(`SELECT uic k, max(name) name, sum(dep_ok) ok, sum(dep_obs) n FROM hist_station_month WHERE month IN ($M) GROUP BY uic`, (_, x) => x.name),
  };
}
const d3group = <T>(rows: T[], key: (r: T) => string) => { const m = new Map<string, T[]>(); for (const r of rows) (m.get(key(r)) ?? m.set(key(r), []).get(key(r))!).push(r); return m; };
/** Monthly punctuality of one train number / line / station's departures since 2018, and the whole span's share. */
const since = (rows: any[]) => {
  if (!rows.length) return null;
  const ok = rows.reduce((a, r) => a + r.ok, 0), n = rows.reduce((a, r) => a + r.n, 0);
  return { months: rows.map((r) => ({ month: r.month, pct: pct(r.ok, r.n), n: r.n })), pct: pct(ok, n), n, from: rows[0].month };
};

// ---------- train number ----------
export function train(d: Day, num: string) {
  return cached(`train:${d.version}:${num}`, 20, () => {
    // yesterday's run counts while it's still running after midnight; the one running now first
    const runs = nowState(d, (t) => t.num === num).filter((x) => x.trip.date === d.date || x.p).sort((a, b) => +!!b.p - +!!a.p).map(({ trip, e, p, c, x }) => ({
      line: lineOf(d, trip.route), cat: category(d, trip.route), operator: d.agencies[trip.agency] ?? trip.agency, cancelled: c, stuckSince: x,
      running: !!p, at: p ? (p.at ? p.a : p.a + p.f) : null,
      stops: Array.from({ length: trip.stops.length / 3 }, (_, k) => ({
        name: d.stations[trip.stops[k * 3]][0], uic: d.stations[trip.stops[k * 3]][3], km: Math.round(trip.km[k] * 10) / 10,
        arr: d.base / 1000 + trip.stops[k * 3 + 1], dep: d.base / 1000 + trip.stops[k * 3 + 2],
        delay: e.delay[k], skipped: e.skipped[k], platform: d.platforms[trip.plat[k]] || null,
      })),
    }));
    const occ = [...occupancyAll()].find(([k]) => k.endsWith(`:${num}`))?.[1]?.sec ?? [];
    return {
      num, runs, crowding: occ,
      history: all(`SELECT date, line, final_delay, max_delay, cancelled, observed, stuck_min FROM trip_day WHERE train_no = ? ORDER BY date`, num),
      older: all(`SELECT date, line, trips, punctual, observed, cancelled, avg_delay FROM agg_train_day WHERE train_no = ? AND date NOT IN (SELECT date FROM trip_day WHERE train_no = ?1) ORDER BY date`, num),
      profile: all(`SELECT idx, uic, count(arr_delay) n, avg(arr_delay) arr, avg(dep_delay) dep, sum(arr_delay >= 180) late FROM stop_obs WHERE train_no = ? GROUP BY idx, uic ORDER BY idx`, num)
        .map((r) => ({ ...r, name: station(d, r.uic)?.name ?? r.uic })),
      vehicles: all(`SELECT date, unit, type, pos, from_uic, to_uic, km FROM vehicle_run WHERE train_no = ? ORDER BY date DESC, pos LIMIT 120`, num),
      since: since(all(`SELECT month, sum(punctual) ok, sum(observed) n FROM hist_train_month WHERE train_no = ? GROUP BY month ORDER BY month`, num)),
    };
  });
}

// ---------- vehicle ----------
export function vehicle(d: Day, unit: string) {
  return cached(`vehicle:${d.version}:${unit}`, 20, () => {
    const t = Date.now() / 1000;
    // today's runs, plus yesterday's while still running after midnight
    const rows = all(`SELECT * FROM vehicle_run WHERE unit = ? AND (date = ? OR arr > ?) ORDER BY dep`, unit, d.date, t - 3600);
    const ids = new Set(rows.map((r) => `${r.trip}|${r.date}`));
    const byId = new Map(nowState(d, (x) => ids.has(`${x.id}|${x.date}`)).map((s) => [`${s.trip.id}|${s.trip.date}`, s]));
    const runs = rows.map((r) => {
      const s = byId.get(`${r.trip}|${r.date}`);
      const delay = s ? (s.p ? s.e.delay[s.p.b] : s.e.delay.at(-1)) : null;
      return {
        train: r.train_no, line: s ? lineOf(d, s.trip.route) : "", cat: s ? category(d, s.trip.route) : "", from: station(d, r.from_uic)?.name ?? r.from_uic,
        to: station(d, r.to_uic)?.name ?? r.to_uic, dep: r.dep, arr: r.arr, km: r.km, delay, cancelled: s?.c ?? false,
        state: s?.c ? "cancelled" : t < r.dep ? "planned" : t > r.arr + (delay ?? 0) ? "done" : "running",
      };
    });
    const spec = one(`SELECT class, type, length_m, seats1, seats2, has_wr FROM vehicle_run WHERE unit = ? ORDER BY date DESC LIMIT 1`, unit);
    return {
      unit, spec, runs, now: runs.find((r) => r.state === "running") ?? null,
      register: one(`SELECT subtype, built, seats1, seats2, length_m, wheelchair FROM rolling_stock WHERE unit = ?`, unit), // SBB's register, if listed
      history: all(`SELECT date, count(*) runs, sum(km) km FROM vehicle_run WHERE unit = ? GROUP BY date
        UNION ALL SELECT date, runs, km FROM agg_vehicle_day WHERE unit = ?1 AND date NOT IN (SELECT date FROM vehicle_run WHERE unit = ?1) ORDER BY date`, unit),
      trains: all(`SELECT train_no, count(*) n FROM vehicle_run WHERE unit = ? GROUP BY train_no ORDER BY n DESC LIMIT 20`, unit),
    };
  });
}

// ---------- fleet ----------
export function fleet(d: Day) {
  return cached(`fleet:${d.version}`, 60, () => {
    const t = Date.now() / 1000, keys = lineKeysOf(d), lineByTrip = new Map(d.trips.map((x, i) => [x.id, keys[i]]));
    const runs = all(`SELECT * FROM vehicle_run WHERE date = ?`, d.date);
    const units = new Map<string, { unit: string; type: string; runs: number; km: number }>();
    const trains = new Map<string, { train: string; line: string; length: number; seats: number; units: string[] }>();
    const mix = new Map<string, Map<string, number>>();
    for (const r of runs) {
      const u = units.get(r.unit) ?? { unit: r.unit, type: r.type, runs: 0, km: 0 };
      u.runs++; u.km += r.km;
      units.set(r.unit, u);
      const line = lineByTrip.get(r.trip) ?? "", tr = trains.get(r.trip) ?? { train: `${lineName(line)} ${r.train_no}`, line, length: 0, seats: 0, units: [] };
      tr.length += r.length_m; tr.seats += r.seats1 + r.seats2; tr.units.push(`${r.type} ${r.unit}`);
      trains.set(r.trip, tr);
      const m = mix.get(line) ?? new Map();
      m.set(r.type, (m.get(r.type) ?? 0) + 1);
      mix.set(line, m);
    }
    const byType = new Map<string, { type: string; cls: string; units: number; km: number }>();
    for (const u of units.values()) { const x = byType.get(u.type) ?? { type: u.type, cls: u.unit.split("-")[0], units: 0, km: 0 }; x.units++; x.km += u.km; byType.set(u.type, x); }
    // build year of every unit in service today that SBB's register lists
    const built = all(`SELECT DISTINCT v.unit, v.type, r.built FROM vehicle_run v JOIN rolling_stock r ON r.unit = v.unit WHERE v.date = ? AND r.built IS NOT NULL`, d.date)
      .map((r) => ({ unit: r.unit, type: r.type, year: +r.built.slice(0, 4), built: r.built }));
    const tr = [...trains.values()];
    return {
      crawled: runs.length, units: units.size,
      byType: [...byType.values()].sort((a, b) => b.units - a.units),
      leaderboard: [...units.values()].sort((a, b) => b.km - a.km).slice(0, 30),
      longest: tr.sort((a, b) => b.length - a.length).slice(0, 8),
      mostSeats: [...tr].sort((a, b) => b.seats - a.seats).slice(0, 8),
      restaurantsNow: runs.filter((r) => r.has_wr && r.dep <= t && t <= r.arr).map((r) => ({ train: r.train_no, line: lineByTrip.get(r.trip) ?? "", unit: r.unit, type: r.type })),
      mixByLine: [...mix].map(([line, m]) => ({ line, total: [...m.values()].reduce((a, b) => a + b, 0), types: [...m].map(([type, n]) => ({ type, n })) }))
        .sort((a, b) => b.total - a.total).slice(0, 16),
      ages: built.map(({ type, year }) => ({ type, year })),
      oldest: [...built].sort((a, b) => a.built.localeCompare(b.built)).slice(0, 6),
      newest: [...built].sort((a, b) => b.built.localeCompare(a.built)).slice(0, 6),
    };
  });
}

// ---------- train types ----------
/**
 * Punctuality of the trains each series ran (last 30 days, at the last Swiss stop) against all trains of the same lines:
 * a series on the punctual S-Bahn isn't better than one on the Gotthard just for that. delta = its % − what its lines did.
 */
function seriesPunctuality() {
  return cached("series", 1800, () => {
    const base = new Map(all(`SELECT line, sum(observed AND NOT cancelled) n, sum(observed AND NOT cancelled AND final_delay < 180) ok FROM trip_day GROUP BY line`).map((r) => [r.line, r]));
    const by = new Map<string, { n: number; ok: number; expected: number }>();
    for (const r of all(`SELECT v.cls, t.line, count(*) n, sum(t.final_delay < 180) ok FROM (SELECT DISTINCT class cls, date, trip FROM vehicle_run) v
      JOIN trip_day t ON t.date = v.date AND t.trip = v.trip WHERE t.observed = 1 AND t.cancelled = 0 GROUP BY v.cls, t.line`)) {
      const b = base.get(r.line), x = by.get(r.cls) ?? by.set(r.cls, { n: 0, ok: 0, expected: 0 }).get(r.cls)!;
      x.n += r.n; x.ok += r.ok; x.expected += b?.n ? (r.n * b.ok) / b.n : 0;
    }
    return new Map([...by].filter(([, x]) => x.n >= 50).map(([cls, x]) => [cls, { runs: x.n, pct: pct(x.ok, x.n), delta: Math.round((1000 * (x.ok - x.expected)) / x.n) / 10 }]));
  });
}
/** Every series seen in a formation or listed in the register: names, how many, how far they ran, where. */
export function types(d: Day) {
  return cached(`types:${d.version}`, 300, () => {
    const keys = lineKeysOf(d), lineByTrip = new Map(d.trips.map((t, i) => [t.id, keys[i]]));
    const by = new Map<string, any>();
    const get = (cls: string) => by.get(cls) ?? by.set(cls, { cls, name: typeName(cls), wiki: wikiOf(cls), about: TYPE_INFO[cls]?.about ?? null, registered: 0, seen: 0, today: 0, kmToday: 0, kmTotal: 0, lines: new Map(), built: null, seats: null, length: null }).get(cls);
    for (const r of all(`SELECT cls, count(*) n, min(built) first, max(built) last, avg(seats1 + seats2) seats, avg(length_m) len FROM rolling_stock GROUP BY cls`))
      Object.assign(get(r.cls), { registered: r.n, built: r.first ? [r.first.slice(0, 4), r.last.slice(0, 4)] : null, seats: r.seats && Math.round(r.seats), length: r.len && Math.round(r.len) });
    for (const r of all(`SELECT class cls, count(DISTINCT unit) n, sum(km) km FROM agg_vehicle_day GROUP BY class`)) Object.assign(get(r.cls), { seen: r.n, kmTotal: r.km });
    for (const r of all(`SELECT class cls, unit, trip, km FROM vehicle_run WHERE date = ?`, d.date)) {
      const x = get(r.cls), line = lineByTrip.get(r.trip);
      x.kmToday += r.km;
      if (line) x.lines.set(line, (x.lines.get(line) ?? 0) + 1);
    }
    for (const r of all(`SELECT class cls, count(DISTINCT unit) n FROM vehicle_run WHERE date = ? GROUP BY class`, d.date)) get(r.cls).today = r.n;
    for (const r of all(`SELECT class cls, count(DISTINCT unit) n FROM vehicle_run GROUP BY class`)) get(r.cls).seen = Math.max(get(r.cls).seen, r.n);
    const punct = seriesPunctuality();
    return [...by.values()].filter((x) => x.seen || x.today || TYPE_INFO[x.cls])
      .map((x) => ({ ...x, punctuality: punct.get(x.cls) ?? null, kmTotal: Math.round(x.kmTotal + x.kmToday), kmToday: Math.round(x.kmToday), lines: [...x.lines].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([l]) => l) }))
      .sort((a, b) => b.today - a.today || b.seen - a.seen || b.registered - a.registered);
  });
}

/** One series: its units (register + what we saw), the lines it runs, distance, build years. */
export function trainType(d: Day, cls: string) {
  if (!/^\d{3}$/.test(cls)) return null;
  return cached(`type:${d.version}:${cls}`, 120, () => {
    const keys = lineKeysOf(d), lineByTrip = new Map(d.trips.map((t, i) => [t.id, keys[i]]));
    const units = new Map<string, any>();
    const get = (unit: string) => units.get(unit) ?? units.set(unit, { unit, subtype: null, built: null, seats: null, runsToday: 0, kmToday: 0, kmTotal: 0, days: 0, last: null }).get(unit);
    for (const r of all(`SELECT unit, subtype, built, seats1, seats2 FROM rolling_stock WHERE cls = ?`, cls)) Object.assign(get(r.unit), { subtype: r.subtype, built: r.built, seats: (r.seats1 ?? 0) + (r.seats2 ?? 0) || null });
    for (const r of all(`SELECT unit, count(*) days, sum(km) km, max(date) last FROM agg_vehicle_day WHERE class = ? GROUP BY unit`, cls)) Object.assign(get(r.unit), { kmTotal: r.km, days: r.days, last: r.last });
    const lines = new Map<string, number>();
    for (const r of all(`SELECT unit, trip, km FROM vehicle_run WHERE class = ? AND date = ?`, cls, d.date)) {
      const u = get(r.unit);
      u.runsToday++; u.kmToday += r.km; u.last = d.date;
      const l = lineByTrip.get(r.trip);
      if (l) lines.set(l, (lines.get(l) ?? 0) + 1);
    }
    if (!units.size) return null;
    // where it usually runs: its lines over the last 30 days, each with the end stations it runs between most
    const usual = new Map<string, { line: string; n: number; ends: Map<string, number> }>();
    for (const r of all(`SELECT t.line, t.origin, t.dest, count(*) n FROM vehicle_run v JOIN trip_day t ON t.date = v.date AND t.trip = v.trip
        WHERE v.class = ? AND v.date >= ? GROUP BY t.line, t.origin, t.dest`, cls, addDays(d.date, -30))) {
      const u = usual.get(r.line) ?? usual.set(r.line, { line: r.line, n: 0, ends: new Map() }).get(r.line)!, k = [r.origin, r.dest].sort().join(" – ");
      u.n += r.n; u.ends.set(k, (u.ends.get(k) ?? 0) + r.n);
    }
    const runs = [...usual.values()].reduce((a, u) => a + u.n, 0);
    const list = [...units.values()].map((u) => ({ ...u, kmToday: Math.round(u.kmToday), kmTotal: Math.round(u.kmTotal + u.kmToday) }));
    return {
      cls, name: typeName(cls), wiki: wikiOf(cls), about: TYPE_INFO[cls]?.about ?? null, punctuality: seriesPunctuality().get(cls) ?? null,
      units: list.sort((a, b) => b.kmToday - a.kmToday || b.kmTotal - a.kmTotal || a.unit.localeCompare(b.unit)),
      lines: [...lines].sort((a, b) => b[1] - a[1]).map(([line, n]) => ({ line, n })),
      usual: [...usual.values()].sort((a, b) => b.n - a.n).slice(0, 8).map((u) => ({ line: u.line, n: u.n, pct: Math.round((100 * u.n) / runs), ends: [...u.ends].sort((a, b) => b[1] - a[1])[0][0] })),
      years: list.filter((u) => u.built).map((u) => +u.built.slice(0, 4)),
    };
  });
}

// ---------- station ----------
export function stationStats(d: Day, uic: string) {
  return cached(`station:${d.version}:${uic}`, 30, () => {
    const s = station(d, uic);
    if (!s) return null;
    const perHour = Array(24).fill(0), plats = new Map<string, number>(), lines = new Map<string, number>(), keys = lineKeysOf(d);
    d.trips.forEach((t, i) => {
      if (t.date !== d.date) return;
      for (let k = 0; k < t.stops.length / 3 - 1; k++) if (t.stops[k * 3] === s.i) {
        perHour[Math.floor(t.stops[k * 3 + 2] / 3600) % 24]++;
        const p = d.platforms[t.plat[k]] || "?", l = keys[i];
        plats.set(p, (plats.get(p) ?? 0) + 1);
        lines.set(l, (lines.get(l) ?? 0) + 1);
      }
    });
    // typical: departures recorded with live data on earlier days of the same weekday, fully recorded days only
    const dow = new Date(`${d.date}T12:00:00Z`).getUTCDay();
    const same = all(`SELECT date, trips, observed FROM agg_net_day WHERE date < ?`, d.date).filter((r) => covered(r) >= COVERED && new Date(`${r.date}T12:00:00Z`).getUTCDay() === dow).map((r) => r.date);
    const typical = Array(24).fill(0);
    for (const r of same.length ? all(`SELECT sched_dep / 3600 h, count(*) n FROM stop_obs WHERE uic = ? AND date IN (${same.map(() => "?").join(",")}) AND sched_dep IS NOT NULL AND skipped = 0 GROUP BY h`, uic, ...same) : [])
      typical[zurich(Math.floor(r.h) * 3600).hour] += r.n / same.length;
    const q = (date: string) => one(`SELECT count(dep_delay) n, sum(dep_delay < 180) ok, avg(dep_delay) avg, avg(arr_delay) arr FROM stop_obs WHERE uic = ? AND date = ? AND skipped = 0`, uic, date);
    const td = q(d.date), month = one(`SELECT count(dep_delay) n, sum(dep_delay < 180) ok, avg(dep_delay) avg, avg(arr_delay) arr, sum(arr_delay >= 180) arr_late, count(arr_delay) arr_n FROM stop_obs WHERE uic = ? AND skipped = 0`, uic);
    return {
      ...s, trips: d.stations[s.i][4], pax: one(`SELECT daily, weekday, year FROM station_pax WHERE uic = ?`, uic),
      busy: all(`SELECT hour, pct, year FROM station_hour WHERE uic = ? ORDER BY hour`, uic), // SBB's count of station users through the day
      edges: all(`SELECT track, length_m, height_cm, type FROM platform_edge WHERE uic = ? ORDER BY CAST(track AS INTEGER), track`, uic),
      perHour: perHour.map((n, hour) => ({ hour, today: n, typical: same.length ? Math.round(typical[hour] * 10) / 10 : null })), typicalDays: same.length,
      first: one(`SELECT min(date) d FROM stop_obs WHERE uic = ?`, uic).d,
      today: { ...td, pct: pct(td.ok, td.n) }, month: { ...month, pct: pct(month.ok, month.n), arrPct: pct(month.arr_n - month.arr_late, month.arr_n) },
      platforms: [...plats].map(([p, n]) => ({ p, n })).sort((a, b) => b.n - a.n),
      lines: [...lines].map(([line, n]) => ({ line, n })).sort((a, b) => b.n - a.n).slice(0, 20),
      daily: all(`SELECT date, deps, dep_obs, dep_ok, avg_dep_delay FROM agg_station_day WHERE uic = ? ORDER BY date`, uic).map((r) => ({ ...r, pct: pct(r.dep_ok, r.dep_obs) })),
      incidents: all(`SELECT id, kind, sev_max, since, first_seen, last_seen, h, why FROM alert_log WHERE stations LIKE ? AND sev_max >= 2 ORDER BY first_seen DESC LIMIT 30`, `%"${uic}"%`),
      since: since(all(`SELECT month, dep_ok ok, dep_obs n FROM hist_station_month WHERE uic = ? ORDER BY month`, uic)),
    };
  });
}

// ---------- line ----------
export function lineStats(d: Day, key: string) {
  return cached(`line:${d.version}:${key}`, 30, () => {
    const keys = lineKeysOf(d);
    if (!key.includes("|")) { // a bare name (old link, the map): its busiest line today
      const n = new Map<string, number>();
      keys.forEach((k) => lineName(k) === key && n.set(k, (n.get(k) ?? 0) + 1));
      key = [...n].sort((a, b) => b[1] - a[1])[0]?.[0] ?? `${key}|`;
    }
    const name = key, trips = d.trips.filter((t, i) => t.date === d.date && keys[i] === key);
    if (!trips.length && !one("SELECT 1 FROM hist_line_month WHERE line = ? LIMIT 1", key)) return null;
    if (!trips.length) return { line: key, cat: null, operator: "", trips: 0, km: 0, stops: [], today: [], daily: [], incidents: [],
      since: since(all(`SELECT month, punctual ok, observed n FROM hist_line_month WHERE line = ? ORDER BY month`, key)) }; // not running today: its history
    const pattern = trips.reduce((a, b) => (b.stops.length > a.stops.length ? b : a)); // the longest variant orders the stops
    const order = Array.from({ length: pattern.stops.length / 3 }, (_, k) => d.stations[pattern.stops[k * 3]][3]);
    const per = new Map(all(`SELECT uic, count(arr_delay) n, avg(arr_delay) arr, sum(arr_delay < 180) ok FROM stop_obs WHERE line = ? AND arr_delay IS NOT NULL GROUP BY uic`, name).map((r) => [r.uic, r]));
    return {
      line: name, cat: category(d, trips[0].route), operator: d.agencies[trips[0].agency] ?? trips[0].agency, trips: trips.length,
      km: Math.round(trips.reduce((a, t) => a + t.km.at(-1)!, 0)),
      stops: order.map((uic) => { const r = per.get(uic); return { uic, name: station(d, uic)?.name ?? uic, n: r?.n ?? 0, arr: r?.arr ?? null, pct: r ? pct(r.ok, r.n) : null }; }),
      today: all(`SELECT train_no, origin, dest, final_delay, cancelled, observed, arr FROM trip_day WHERE line = ? AND date = ? ORDER BY arr`, name, d.date),
      daily: all(`SELECT date, trips, observed, punctual, cancelled, avg_delay FROM agg_line_day WHERE line = ? ORDER BY date`, name).map((r) => ({ ...r, pct: pct(r.punctual, r.observed - r.cancelled) })),
      incidents: all(`SELECT id, kind, sev_max, since, first_seen, last_seen, h, why FROM alert_log WHERE lines LIKE ? AND sev_max >= 2 ORDER BY first_seen DESC LIMIT 30`, `%"${lineName(name)}"%`), // alerts name lines
      since: since(all(`SELECT month, punctual ok, observed n FROM hist_line_month WHERE line = ? ORDER BY month`, name)),
    };
  });
}

// ---------- incidents ----------
export function incidents(d: Day) {
  return cached(`incidents:${d.version}`, 60, () => {
    const rows = all(`SELECT id, kind, cause, sev_max, sudden, since, first_seen, last_seen, h, why, d, stations, lines FROM alert_log
      WHERE first_seen >= ? ORDER BY first_seen DESC`, Date.now() / 1000 - 30 * 86400).map((r) => ({ ...r, stations: JSON.parse(r.stations), lines: JSON.parse(r.lines) }));
    const spots = new Map<string, number>();
    for (const r of rows) if (r.sev_max >= 2) for (const u of r.stations) spots.set(u, (spots.get(u) ?? 0) + 1);
    return {
      rows: rows.map((r) => ({ ...r, stations: r.stations.map((u: string) => station(d, u)?.name ?? u) })),
      hotspots: [...spots].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([u, n]) => ({ ...station(d, u), n })).filter((x) => x.name),
    };
  });
}

// ---------- search (stats page) ----------
const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase(); // "zurich" finds Zürich, "geneve" Genève
export function search(d: Day, q: string) {
  q = fold(q.trim());
  if (!q) return [];
  const out: { kind: string; key: string; label: string; sub: string }[] = [];
  if (/^\d{3}-?\d{0,3}$/.test(q)) for (const r of all(`SELECT unit, type, count(*) n FROM vehicle_run WHERE unit LIKE ? GROUP BY unit ORDER BY unit LIMIT 5`, `${q.replace(/^(\d{3})(\d)/, "$1-$2")}%`))
    out.push({ kind: "vehicle", key: r.unit, label: `${r.type} ${r.unit}`, sub: `${r.n} runs recorded` });
  if (/^\d+$/.test(q)) {
    const seen = new Set<string>();
    for (const t of d.trips) if (t.date === d.date && t.num.startsWith(q) && !seen.has(t.num) && seen.size < 6) {
      seen.add(t.num);
      out.push({ kind: "train", key: t.num, label: `${lineOf(d, t.route)} ${t.num}`, sub: `${d.stations[t.stops[0]][0]} → ${t.head}` });
    }
  }
  const lines = new Set<string>(), labels = lineLabels(d);
  for (const l of lineKeysOf(d)) if (fold(lineName(l)).startsWith(q) && !l.endsWith("|")) lines.add(l);
  for (const l of [...lines].sort((a, b) => a.length - b.length || a.localeCompare(b)).slice(0, 5)) out.push({ kind: "line", key: l, label: labels[l] ?? lineName(l), sub: "line" });
  for (const s of d.stations.filter((s) => s[4] && fold(s[0]).includes(q)).sort((a, b) => +fold(b[0]).startsWith(q) - +fold(a[0]).startsWith(q) || b[4] - a[4]).slice(0, 8))
    out.push({ kind: "station", key: s[3], label: s[0], sub: `${s[4]} trains today` });
  return out.slice(0, 12);
}

// ---------- network (line sections, all trains incl. freight) ----------
export function network() {
  return cached("network", 3600, () => {
    const tot = one(`SELECT max(year) year, count(*) n, sum(trains) trains, sum(freight) freight, sum(train_km) km, sum(kwh) kwh FROM section_traffic`);
    if (!tot.n) return null;
    const row = (r: any) => ({ a: r.name_a, b: r.name_b, line: r.line, perDay: Math.round(r.trains / 365), freightPerDay: Math.round(r.freight / 365), freight: pct(r.freight, r.trains), tonnesPerDay: Math.round(r.tonnes / 365) });
    return {
      year: tot.year, sections: tot.n, kwhPerKm: tot.km ? Math.round((10 * tot.kwh) / tot.km) / 10 : null, km: Math.round(tot.km),
      freightShare: pct(one(`SELECT sum(train_km * freight / trains) f FROM section_traffic WHERE trains > 0`).f, tot.km), // of train-km
      busiest: all(`SELECT * FROM section_traffic ORDER BY trains DESC LIMIT 15`).map(row),
      freight: all(`SELECT * FROM section_traffic ORDER BY freight DESC LIMIT 15`).map(row),
      heaviest: all(`SELECT * FROM section_traffic ORDER BY tonnes DESC LIMIT 10`).map(row),
    };
  });
}

// ---------- records ----------
/** Bests and worsts: whole days since 2018, the longest delays and disruptions recorded, today's timetable extremes. */
export function records(d: Day) {
  return cached(`records:${d.version}`, 600, () => {
    const h = longHistory(), days = (h?.calendar ?? []).filter((x: any) => !x[3] && x[1] != null);
    const byPct = [...days].sort((a: any, b: any) => a[1] - b[1]);
    const canc = all(`SELECT date, cancelled, trips FROM hist_net_day ORDER BY cancelled * 1.0 / trips DESC LIMIT 40`).filter((r) => days.some((x: any) => x[0] === r.date)).slice(0, 5);
    // busiest hour of a weekday: departures recorded per hour, averaged over the weekdays imported
    const weekdays = one(`SELECT count(*) n FROM hist_net_day WHERE CAST(strftime('%w', date) AS INTEGER) BETWEEN 1 AND 5`).n || 1;
    const hours = all(`SELECT hour, sum(n) n, sum(late) late FROM hist_hour_month WHERE dow < 5 GROUP BY hour ORDER BY hour`).map((r) => ({ hour: r.hour, perDay: Math.round(r.n / weekdays), late: pct(r.late, r.n) }));
    const F = facts(d);
    return {
      bestDays: byPct.slice(-5).reverse().map(([date, p, trips]: any) => ({ date, pct: p, trips })),
      worstDays: byPct.slice(0, 5).map(([date, p, trips]: any) => ({ date, pct: p, trips })),
      cancelDays: canc.map((r) => ({ date: r.date, cancelled: r.cancelled, pct: pct(r.cancelled, r.trips) })),
      months: (h?.months ?? []).filter((m: any) => m.days >= 28 && !m.missing).sort((a: any, b: any) => a.pct - b.pct).filter((_: any, k: number, a: any[]) => k < 3 || k >= a.length - 3),
      hours,
      delays: all(`SELECT train_no, line, month, max_delay FROM hist_train_month WHERE line NOT LIKE '%|' ORDER BY max_delay DESC LIMIT 8`),
      delaysLive: all(`SELECT date, train_no, line, origin, dest, max_delay FROM trip_day WHERE observed = 1 ORDER BY max_delay DESC LIMIT 8`),
      disruptions: all(`SELECT id, h, why, kind, sev_max, coalesce(since, first_seen) start, last_seen, last_seen - coalesce(since, first_seen) dur FROM alert_log
        WHERE sev_max >= 2 ORDER BY dur DESC LIMIT 8`),
      fastest: F.fastest.slice(0, 3), longest: F.longestTrips.slice(0, 3), longestNonstop: F.longestNonstop.slice(0, 3),
    };
  });
}

// ---------- commute ----------
/**
 * Every recorded train from station a to station b (the same run, b after a) over the last 30 days: how punctual at b,
 * by hour of departure from a, and per train. Live recordings only: the official history has no per-stop pairs.
 */
export function commute(d: Day, a: string, b: string) {
  const A = station(d, a), B = station(d, b);
  if (!A || !B || a === b) return null;
  return cached(`commute:${d.date}:${a}:${b}`, 1800, () => {
    const rows = all(`SELECT x.date, x.train_no, x.line, x.sched_dep dep, y.sched_arr arr, y.arr_delay delay FROM stop_obs x
      JOIN stop_obs y ON y.date = x.date AND y.trip = x.trip AND y.idx > x.idx
      WHERE x.uic = ? AND y.uic = ? AND x.date >= ? AND x.sched_dep IS NOT NULL AND y.arr_delay IS NOT NULL AND x.skipped = 0 AND y.skipped = 0`, a, b, addDays(d.date, -30));
    const q = (xs: number[], f: number) => { const s = [...xs].sort((u, v) => u - v); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * f))] : null; };
    const hours = new Map<number, number[]>(), trains = new Map<string, { train_no: string; line: string; n: number; ok: number; dep: number }>();
    for (const r of rows) {
      const h = zurich(r.dep).hour;
      (hours.get(h) ?? hours.set(h, []).get(h)!).push(r.delay);
      const t = trains.get(r.train_no) ?? trains.set(r.train_no, { train_no: r.train_no, line: r.line, n: 0, ok: 0, dep: r.dep }).get(r.train_no)!;
      t.n++; t.ok += +(r.delay < 180);
    }
    const all_ = rows.map((r) => r.delay), days = new Set(rows.map((r) => r.date)).size;
    return {
      a: A, b: B, runs: rows.length, days, perDay: days ? Math.round(rows.length / days) : 0,
      pct: pct(all_.filter((x) => x < 180).length, all_.length), median: q(all_, 0.5), p90: q(all_, 0.9),
      minutes: q(rows.map((r) => r.arr - r.dep), 0.5),
      hours: [...hours].sort((x, y) => x[0] - y[0]).map(([hour, xs]) => ({ hour, n: xs.length, pct: pct(xs.filter((x) => x < 180).length, xs.length), median: q(xs, 0.5), p90: q(xs, 0.9) })),
      trains: [...trains.values()].sort((x, y) => y.n - x.n).slice(0, 20).map((t) => ({ ...t, pct: pct(t.ok, t.n), dep: zurich(t.dep).hour * 60 + Math.floor((t.dep % 3600) / 60) })),
    };
  });
}

// ---------- where time is lost (map layer) ----------
/** Per section over the last 30 days, both directions together: [uicA, uicB, average seconds gained, trains]. */
export function segments() {
  return cached("segments", 3600, () => {
    const by = new Map<string, [string, string, number, number]>();
    for (const r of all(`SELECT a, b, sum(n) n, sum(sum_gain) s FROM agg_seg_day WHERE date >= ? GROUP BY a, b`, addDays(zurichDate(new Date()), -30))) {
      const [x, y] = r.a < r.b ? [r.a, r.b] : [r.b, r.a], k = `${x}|${y}`, v = by.get(k) ?? by.set(k, [x, y, 0, 0]).get(k)!;
      v[2] += r.n; v[3] += r.s;
    }
    return [...by.values()].filter((v) => v[2] >= 30).map(([a, b, n, s]) => [a, b, Math.round(s / n), n]);
  });
}

// ---------- line labels ----------
/** "S1|8500010" -> "S1 · Basel SBB", for every line whose name another line shares (today's and the history's). */
export function lineLabels(d: Day) {
  return cached(`labels:${d.version}`, 3600, () => {
    const hist = new Map(all(`SELECT uic, max(name) name FROM hist_station_month GROUP BY uic`).map((r) => [r.uic, r.name]));
    const keys = [...lineKeysOf(d), ...all(`SELECT DISTINCT line FROM hist_line_month`).map((r) => r.line), ...all(`SELECT DISTINCT line FROM agg_line_day`).map((r) => r.line)];
    return ambiguousLabels(keys, (uic) => station(d, uic)?.name ?? hist.get(uic));
  });
}
