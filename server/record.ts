// History for the stats page: finished trips, per-stop delays, network samples, alerts, vehicle runs.
// Detail is kept 30 days; daily aggregates are kept forever.
import { Database } from "bun:sqlite";
import { applyDelays } from "../public/position.js";
import { addDays, serviceBase, zurichDate } from "./time";
import type { Day } from "./gtfs";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS trip_day (date TEXT, trip TEXT, train_no TEXT, line TEXT, cat TEXT, agency TEXT, origin TEXT, dest TEXT,
  dep INTEGER, arr INTEGER, km REAL, observed INTEGER, cancelled INTEGER, final_delay INTEGER, max_delay INTEGER,
  stops INTEGER, stops_ok INTEGER, stuck_min REAL, PRIMARY KEY (date, trip));
CREATE INDEX IF NOT EXISTS trip_day_no ON trip_day (train_no, date);
CREATE TABLE IF NOT EXISTS stop_obs (date TEXT, trip TEXT, train_no TEXT, line TEXT, idx INTEGER, uic TEXT,
  sched_arr INTEGER, sched_dep INTEGER, arr_delay INTEGER, dep_delay INTEGER, skipped INTEGER, PRIMARY KEY (date, trip, idx));
CREATE INDEX IF NOT EXISTS stop_obs_uic ON stop_obs (uic, date);
CREATE INDEX IF NOT EXISTS stop_obs_no ON stop_obs (train_no);
CREATE INDEX IF NOT EXISTS stop_obs_line ON stop_obs (line);
CREATE TABLE IF NOT EXISTS net_sample (t INTEGER PRIMARY KEY, running INTEGER, late INTEGER, cancelled INTEGER, stuck INTEGER, observed INTEGER);
CREATE TABLE IF NOT EXISTS alert_log (id TEXT PRIMARY KEY, first_seen INTEGER, last_seen INTEGER, since INTEGER, sev_max INTEGER,
  sudden INTEGER, kind TEXT, cause TEXT, why TEXT, h TEXT, d TEXT, stations TEXT, lines TEXT);
CREATE TABLE IF NOT EXISTS vehicle_run (date TEXT, unit TEXT, class TEXT, type TEXT, train_no TEXT, trip TEXT, pos INTEGER,
  from_uic TEXT, to_uic TEXT, dep INTEGER, arr INTEGER, km REAL, length_m REAL, seats1 INTEGER, seats2 INTEGER, has_wr INTEGER,
  PRIMARY KEY (date, unit, trip));
CREATE INDEX IF NOT EXISTS vehicle_run_trip ON vehicle_run (date, train_no);
CREATE TABLE IF NOT EXISTS agg_net_day (date TEXT PRIMARY KEY, trips INTEGER, observed INTEGER, punctual INTEGER, cancelled INTEGER,
  km REAL, avg_delay REAL, p90_delay INTEGER, stop_obs INTEGER, stop_ok INTEGER);
CREATE TABLE IF NOT EXISTS agg_train_day (date TEXT, train_no TEXT, line TEXT, cat TEXT, agency TEXT, trips INTEGER, observed INTEGER,
  punctual INTEGER, cancelled INTEGER, avg_delay REAL, max_delay INTEGER, km REAL, PRIMARY KEY (date, train_no, line));
CREATE TABLE IF NOT EXISTS agg_station_day (date TEXT, uic TEXT, deps INTEGER, dep_obs INTEGER, dep_ok INTEGER, avg_dep_delay REAL,
  PRIMARY KEY (date, uic));
CREATE TABLE IF NOT EXISTS agg_line_day (date TEXT, line TEXT, cat TEXT, trips INTEGER, observed INTEGER, punctual INTEGER,
  cancelled INTEGER, avg_delay REAL, km REAL, PRIMARY KEY (date, line));
CREATE TABLE IF NOT EXISTS upstream_call (api TEXT, t INTEGER);
CREATE INDEX IF NOT EXISTS upstream_call_t ON upstream_call (api, t);
CREATE TABLE IF NOT EXISTS formation_cache (key TEXT PRIMARY KEY, date TEXT, status TEXT, t INTEGER, json TEXT);
DROP TABLE IF EXISTS crawl_done;
CREATE TABLE IF NOT EXISTS station_pax (uic TEXT PRIMARY KEY, year INTEGER, daily INTEGER, weekday INTEGER);
CREATE TABLE IF NOT EXISTS rolling_stock (unit TEXT PRIMARY KEY, cls TEXT, subtype TEXT, built TEXT, seats1 INTEGER, seats2 INTEGER, length_m REAL, wheelchair INTEGER);
CREATE TABLE IF NOT EXISTS sbb_loaded (name TEXT PRIMARY KEY, t INTEGER);
CREATE TABLE IF NOT EXISTS agg_vehicle_day (date TEXT, unit TEXT, class TEXT, type TEXT, runs INTEGER, km REAL, PRIMARY KEY (date, unit));
`;
const KEEP_DAYS = 30;
const LATE = 180; // punctual = less than 3 min late, the SBB threshold
const GRACE = 20 * 60; // write a trip this long after its arrival, so late updates still land

export let db: Database;
type State = { u?: (number | null)[][]; c?: 1; stuck: number };
let dayOf: Day | undefined;
const state = new Map<number, State>(); // trip index of the current day -> what realtime told us
const flushed = new Set<string>(); // `${trip id}|${service date}` already in trip_day
let lastFlush = 0;

export function initRecord(file: string) {
  db = new Database(file, { create: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
  db.exec(SCHEMA);
  try { db.exec("ALTER TABLE net_sample ADD COLUMN observed INTEGER"); } catch {} // databases from before the column
  return db;
}

export const lineOf = (d: Day, route: number) => d.routes[route][0] || d.routes[route][1];
const key = (id: string, date: string) => `${id}|${date}`;

/** Called when a new service day is loaded: finish the old one, remember what's already stored for the new one. */
export function startDay(d: Day, nowSec = Date.now() / 1000) {
  if (dayOf && dayOf !== d) flush(dayOf, nowSec, 0);
  dayOf = d;
  state.clear();
  flushed.clear();
  // a restart must not overwrite stored trips with empty state
  const dates = [...new Set(d.trips.map((t) => t.date))];
  for (const date of dates) for (const r of db.query("SELECT trip FROM trip_day WHERE date = ?").all(date) as { trip: string }[]) flushed.add(key(r.trip, date));
}

/** Every trip-update poll: merge realtime state, store the network sample, flush finished trips every 5 min. */
export function recordTrips(d: Day, delays: Record<number, { c?: 1; u?: (number | null)[][]; x?: number }>, feedTime: number, sample: [number, number, number, number, number]) {
  if (dayOf !== d) startDay(d, feedTime);
  for (const [i, v] of Object.entries(delays)) {
    const st = state.get(+i) ?? { stuck: 0 };
    if (v.u) st.u = v.u;
    if (v.c) st.c = 1;
    if (v.x) st.stuck += 0.25; // minutes: one poll every 15 s
    state.set(+i, st);
  }
  db.query("INSERT OR REPLACE INTO net_sample VALUES (?, ?, ?, ?, ?, ?)").run(feedTime, ...sample);
  if (feedTime - lastFlush >= 300) {
    lastFlush = feedTime;
    flush(d, feedTime, GRACE);
  }
}

/** Write every trip that arrived more than `grace` seconds before `nowSec` and isn't stored yet. */
export function flush(d: Day, nowSec: number, grace: number) {
  const t = nowSec - d.base / 1000;
  const insTrip = db.query("INSERT OR REPLACE INTO trip_day VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  const insStop = db.query("INSERT OR REPLACE INTO stop_obs VALUES (?,?,?,?,?,?,?,?,?,?,?)");
  let n = 0;
  db.transaction(() => {
    d.trips.forEach((trip, i) => {
      const k = key(trip.id, trip.date);
      if (flushed.has(k)) return;
      const st = state.get(i), s = trip.stops, last = s.length / 3 - 1;
      const e = applyDelays(s, st?.u);
      if (e.stops[last * 3 + 1] + grace > t) return; // still running, or not long enough ago
      const observed = st ? 1 : 0, base = d.base / 1000, line = lineOf(d, trip.route), stations = d.stations;
      let stops = 0, ok = 0, max = 0;
      for (let p = 0; p <= last; p++) {
        const arr = p ? e.stops[p * 3 + 1] - s[p * 3 + 1] : null, dep = p < last ? e.stops[p * 3 + 2] - s[p * 3 + 2] : null;
        if (p && !e.skipped[p]) { stops++; if (arr! < LATE) ok++; max = Math.max(max, arr!); }
        // per-stop rows only carry delays: a trip realtime never mentioned, or a cancelled one, would just be timetable copies
        if (observed && !st!.c) insStop.run(trip.date, trip.id, trip.num, line, p, stations[s[p * 3]][3], p ? base + s[p * 3 + 1] : null, p < last ? base + s[p * 3 + 2] : null,
          arr, dep, e.skipped[p] ? 1 : 0);
      }
      const final = e.stops[last * 3 + 1] - s[last * 3 + 1];
      insTrip.run(trip.date, trip.id, trip.num, line, d.routes[trip.route][1], trip.agency, stations[s[0]][0], stations[s[last * 3]][0],
        base + s[2], base + s[last * 3 + 1], +trip.km[last].toFixed(2), observed, st?.c ? 1 : 0,
        observed ? final : null, observed ? max : null, stops, observed ? ok : null, st?.stuck ?? 0);
      flushed.add(k);
      n++;
    });
  })();
  if (n) console.log(`[record] stored ${n} finished trips`);
}

type Alert = { id: string; h: string; d: string; sev: number; sudden?: 1; kind: string; cause: string; why: string; from: number; s: number[]; r: number[] };
export function recordAlerts(d: Day, alerts: Alert[], nowSec = Date.now() / 1000) {
  const up = db.query(`INSERT INTO alert_log VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
    last_seen = excluded.last_seen, sev_max = max(sev_max, excluded.sev_max), sudden = max(sudden, excluded.sudden),
    h = excluded.h, d = excluded.d, why = excluded.why, stations = excluded.stations, lines = excluded.lines`);
  db.transaction(() => {
    for (const a of alerts) up.run(a.id, nowSec, nowSec, a.from || null, a.sev, a.sudden ? 1 : 0, a.kind, a.cause, a.why, a.h, a.d,
      JSON.stringify(a.s.map((i) => d.stations[i][3])), JSON.stringify(a.r.map((r) => lineOf(d, r))));
  })();
}

/** Write what's finished, e.g. before the process stops: trips that ended within the grace period are otherwise lost. */
export const flushAll = () => dayOf && flush(dayOf, Date.now() / 1000, 0);

/** Aggregate finished days, then drop detail older than 30 days. Cheap; called every 10 min. */
export function maintain(now = new Date()) {
  const today = zurichDate(now), yesterday = addDays(today, -1), hour = (now.getTime() - serviceBase(today)) / 3600_000;
  // yesterday's last trips run until ~03:00 today, so wait until 04:00 before summarising it
  const ready = (date: string) => date < yesterday || (date === yesterday && hour > 4);
  // a day only seen as the after-midnight tail of the first start (nothing observed) isn't a day of data
  const pending = db.query(`SELECT date FROM trip_day WHERE date < ? AND date NOT IN (SELECT date FROM agg_net_day)
    GROUP BY date HAVING sum(observed) > 0`).all(today) as { date: string }[];
  for (const { date } of pending) if (ready(date)) aggregate(date);
  // night trains dated yesterday arrive until ~10:00 and are stored after that: refresh yesterday's summary until noon
  if (hour > 4 && hour < 12 && !pending.some((p) => p.date === yesterday) && db.query("SELECT 1 FROM agg_net_day WHERE date = ?").get(yesterday)) aggregate(yesterday);
  const cutoff = addDays(today, -KEEP_DAYS);
  db.query("DELETE FROM stop_obs WHERE date < ?").run(cutoff);
  db.query("DELETE FROM trip_day WHERE date < ?").run(cutoff);
  db.query("DELETE FROM vehicle_run WHERE date < ?").run(cutoff);
  db.query("DELETE FROM formation_cache WHERE date < ?").run(addDays(today, -3));
  db.query("DELETE FROM upstream_call WHERE t < ?").run(now.getTime() - 2 * 86400_000);
  db.query("DELETE FROM net_sample WHERE t < ?").run(serviceBase(cutoff) / 1000);
}

const P = `observed = 1 AND cancelled = 0 AND final_delay < ${LATE}`;
export function aggregate(date: string) {
  db.transaction(() => {
    const finals = (db.query("SELECT final_delay f FROM trip_day WHERE date = ? AND observed = 1 AND cancelled = 0 ORDER BY final_delay").all(date) as { f: number }[]).map((r) => r.f);
    const p90 = finals.length ? finals[Math.floor(finals.length * 0.9)] : null;
    db.query(`INSERT OR REPLACE INTO agg_net_day SELECT date, count(*), sum(observed), sum(${P}), sum(cancelled), sum(km * (1 - cancelled)),
      avg(CASE WHEN observed = 1 AND cancelled = 0 THEN final_delay END), $p90,
      (SELECT count(*) FROM stop_obs WHERE date = $date AND arr_delay IS NOT NULL AND skipped = 0),
      (SELECT count(*) FROM stop_obs WHERE date = $date AND arr_delay < ${LATE} AND skipped = 0)
      FROM trip_day WHERE date = $date`).run({ $date: date, $p90: p90 });
    db.query(`INSERT OR REPLACE INTO agg_train_day SELECT date, train_no, line, cat, agency, count(*), sum(observed), sum(${P}), sum(cancelled),
      avg(CASE WHEN observed = 1 AND cancelled = 0 THEN final_delay END), max(max_delay), sum(km * (1 - cancelled)) FROM trip_day WHERE date = ? GROUP BY train_no, line`).run(date);
    db.query(`INSERT OR REPLACE INTO agg_line_day SELECT date, line, cat, count(*), sum(observed), sum(${P}), sum(cancelled),
      avg(CASE WHEN observed = 1 AND cancelled = 0 THEN final_delay END), sum(km * (1 - cancelled)) FROM trip_day WHERE date = ? GROUP BY line`).run(date);
    db.query(`INSERT OR REPLACE INTO agg_station_day SELECT date, uic, count(sched_dep), count(dep_delay), sum(dep_delay < ${LATE}), avg(dep_delay)
      FROM stop_obs WHERE date = ? AND sched_dep IS NOT NULL GROUP BY uic`).run(date);
    db.query(`INSERT OR REPLACE INTO agg_vehicle_day SELECT date, unit, class, type, count(*), sum(km) FROM vehicle_run WHERE date = ? GROUP BY unit`).run(date);
  })();
  console.log(`[record] aggregated ${date}`);
}
