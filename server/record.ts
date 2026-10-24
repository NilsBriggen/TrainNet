// History for the stats page: finished trips, per-stop delays, network samples, alerts, vehicle runs.
// Detail is kept 30 days; daily aggregates are kept forever.
import { Database } from "bun:sqlite";
import { applyDelays } from "../public/position.js";
import { addDays, serviceBase, zurichDate } from "./time";
import type { Day } from "./gtfs";
import { initHistory } from "./history";
import { lineKeys, lineName } from "./lines";

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
CREATE INDEX IF NOT EXISTS vehicle_run_unit ON vehicle_run (unit);
CREATE TABLE IF NOT EXISTS agg_net_day (date TEXT PRIMARY KEY, trips INTEGER, observed INTEGER, punctual INTEGER, cancelled INTEGER,
  km REAL, avg_delay REAL, p90_delay INTEGER, stop_obs INTEGER, stop_ok INTEGER);
CREATE TABLE IF NOT EXISTS agg_train_day (date TEXT, train_no TEXT, line TEXT, cat TEXT, agency TEXT, trips INTEGER, observed INTEGER,
  punctual INTEGER, cancelled INTEGER, avg_delay REAL, max_delay INTEGER, km REAL, PRIMARY KEY (date, train_no, line));
CREATE TABLE IF NOT EXISTS agg_station_day (date TEXT, uic TEXT, deps INTEGER, dep_obs INTEGER, dep_ok INTEGER, avg_dep_delay REAL,
  PRIMARY KEY (date, uic));
CREATE TABLE IF NOT EXISTS agg_line_day (date TEXT, line TEXT, cat TEXT, trips INTEGER, observed INTEGER, punctual INTEGER,
  cancelled INTEGER, avg_delay REAL, km REAL, PRIMARY KEY (date, line));
CREATE INDEX IF NOT EXISTS agg_train_day_no ON agg_train_day (train_no);
CREATE TABLE IF NOT EXISTS agg_seg_day (date TEXT, a TEXT, b TEXT, n INTEGER, sum_gain INTEGER, PRIMARY KEY (date, a, b));
CREATE TABLE IF NOT EXISTS upstream_call (api TEXT, t INTEGER);
CREATE INDEX IF NOT EXISTS upstream_call_t ON upstream_call (api, t);
CREATE TABLE IF NOT EXISTS formation_cache (key TEXT PRIMARY KEY, date TEXT, status TEXT, t INTEGER, json TEXT);
DROP TABLE IF EXISTS crawl_done;
CREATE TABLE IF NOT EXISTS station_pax (uic TEXT PRIMARY KEY, year INTEGER, daily INTEGER, weekday INTEGER);
CREATE TABLE IF NOT EXISTS rolling_stock (unit TEXT PRIMARY KEY, cls TEXT, subtype TEXT, built TEXT, seats1 INTEGER, seats2 INTEGER, length_m REAL, wheelchair INTEGER);
CREATE TABLE IF NOT EXISTS sbb_loaded (name TEXT PRIMARY KEY, t INTEGER);
CREATE TABLE IF NOT EXISTS alert_entity (entity TEXT PRIMARY KEY, id TEXT, last_seen INTEGER);
CREATE TABLE IF NOT EXISTS platform_sector (uic TEXT, track TEXT, sector TEXT, lon REAL, lat REAL, PRIMARY KEY (uic, track, sector));
CREATE TABLE IF NOT EXISTS agg_vehicle_day (date TEXT, unit TEXT, class TEXT, type TEXT, runs INTEGER, km REAL, PRIMARY KEY (date, unit));
CREATE INDEX IF NOT EXISTS agg_vehicle_day_unit ON agg_vehicle_day (unit);
CREATE INDEX IF NOT EXISTS agg_vehicle_day_class ON agg_vehicle_day (class);
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
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;"); // the history backfill may write meanwhile
  db.exec(SCHEMA);
  initHistory(db);
  try { db.exec("ALTER TABLE net_sample ADD COLUMN observed INTEGER"); } catch {} // databases from before the column
  return db;
}

/** A route's line name for display ("IC5", or the category when it has none). Identity is lineKeysOf(). */
export const lineOf = (d: Day, route: number) => d.routes[route][0] || d.routes[route][1];

const keysCache = new WeakMap<Day, string[]>();
/** Line key of every trip of a day ("S1|8500010"): the same identity as the history's (server/lines.ts), Swiss stations only like it. */
export function lineKeysOf(d: Day) {
  let k = keysCache.get(d);
  if (!k) {
    const pax = new Map((db.query("SELECT uic, daily FROM station_pax").all() as { uic: string; daily: number }[]).map((r) => [r.uic, r.daily]));
    k = lineKeys(d.trips.map((t) => ({
      name: d.routes[t.route][0], cat: d.routes[t.route][1],
      uics: Array.from({ length: t.stops.length / 3 }, (_, j) => d.stations[t.stops[j * 3]][3]).filter((u) => u.startsWith("85")),
    })), (u) => pax.get(u) ?? 0);
    keysCache.set(d, k);
  }
  return k;
}
const key = (id: string, date: string) => `${id}|${date}`;

/** Called when a new service day is loaded: finish the old one, remember what's already stored for the new one. */
export function startDay(d: Day, nowSec = Date.now() / 1000) {
  if (dayOf && dayOf !== d) flush(dayOf, nowSec, 0);
  dayOf = d;
  state.clear();
  flushed.clear();
  migrateLineKeys(d);
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
  const done: string[] = [];
  db.transaction(() => {
    d.trips.forEach((trip, i) => {
      const k = key(trip.id, trip.date);
      if (flushed.has(k)) return;
      const st = state.get(i), s = trip.stops, last = s.length / 3 - 1;
      const e = applyDelays(s, st?.u);
      if (e.stops[last * 3 + 1] + grace > t) return; // still running, or not long enough ago
      const observed = st ? 1 : 0, base = d.base / 1000, line = lineKeysOf(d)[i], stations = d.stations;
      let stops = 0, ok = 0, max = 0;
      for (let p = 0; p <= last; p++) {
        const arr = p ? e.stops[p * 3 + 1] - s[p * 3 + 1] : null, dep = p < last ? e.stops[p * 3 + 2] - s[p * 3 + 2] : null;
        if (p && !e.skipped[p]) { stops++; if (arr! < LATE) ok++; max = Math.max(max, arr!); }
        // per-stop rows only carry delays: a trip realtime never mentioned, or a cancelled one, would just be timetable copies
        if (observed && !st!.c) insStop.run(trip.date, trip.id, trip.num, line, p, stations[s[p * 3]][3], p ? base + s[p * 3 + 1] : null, p < last ? base + s[p * 3 + 2] : null,
          arr, dep, e.skipped[p] ? 1 : 0);
      }
      // punctuality at the last Swiss stop, like the official figures (and the history): a delay in Milano isn't ours
      let fin = last;
      while (fin > 1 && (!stations[s[fin * 3]][3].startsWith("85") || e.skipped[fin])) fin--;
      const final = e.stops[fin * 3 + 1] - s[fin * 3 + 1];
      insTrip.run(trip.date, trip.id, trip.num, line, d.routes[trip.route][1], trip.agency, stations[s[0]][0], stations[s[last * 3]][0],
        base + s[2], base + s[last * 3 + 1], +trip.km[last].toFixed(2), observed, st?.c ? 1 : 0,
        observed ? final : null, observed ? max : null, stops, observed ? ok : null, st?.stuck ?? 0);
      done.push(k);
    });
  })();
  for (const k of done) flushed.add(k); // only once committed: a rolled-back write is tried again
  if (done.length) console.log(`[record] stored ${done.length} finished trips`);
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

/**
 * One-off: rows stored before lines had keys carry the bare name ("S1"). They get today's key for that name when it's
 * unambiguous, else the key of the line calling at the trip's first recorded station; then their days are summarised again.
 */
function migrateLineKeys(d: Day) {
  if (!db.query("SELECT 1 FROM trip_day WHERE line NOT LIKE '%|%' LIMIT 1").get()) return;
  const keys = lineKeysOf(d), byName = new Map<string, Set<string>>(), atStation = new Map<string, string>();
  d.trips.forEach((t, i) => {
    const k = keys[i], n = lineName(k);
    (byName.get(n) ?? byName.set(n, new Set()).get(n)!).add(k);
    for (let j = 0; j < t.stops.length / 3; j++) atStation.set(`${n}@${d.stations[t.stops[j * 3]][3]}`, k);
  });
  const firstUic = db.query("SELECT uic FROM stop_obs WHERE date = ? AND trip = ? ORDER BY idx LIMIT 1");
  const setTrip = db.query("UPDATE trip_day SET line = ? WHERE date = ? AND trip = ?"), setStops = db.query("UPDATE stop_obs SET line = ? WHERE date = ? AND trip = ?");
  db.transaction(() => {
    for (const r of db.query("SELECT date, trip, line, cat FROM trip_day WHERE line NOT LIKE '%|%'").all() as { date: string; trip: string; line: string; cat: string }[]) {
      const known = byName.get(r.line), uic = (firstUic.get(r.date, r.trip) as { uic: string } | null)?.uic;
      const k = r.line === r.cat ? `${r.cat}|` : known?.size === 1 ? [...known][0] : (uic && atStation.get(`${r.line}@${uic}`)) || `${r.line}|${uic ?? ""}`;
      setTrip.run(k, r.date, r.trip);
      setStops.run(k, r.date, r.trip);
    }
    db.query("DELETE FROM agg_line_day WHERE line NOT LIKE '%|%'").run(); // summaries of the old names: rebuilt below
    db.query("DELETE FROM agg_train_day WHERE line NOT LIKE '%|%'").run();
  })();
  for (const { date } of db.query("SELECT date FROM agg_net_day WHERE date IN (SELECT DISTINCT date FROM trip_day)").all() as { date: string }[]) aggregate(date);
  console.log("[record] stored lines re-keyed");
}

let refreshed = ""; // the yesterday whose summary was redone after the night trains
/** Aggregate finished days, then drop detail older than 30 days. Cheap; called every 10 min. */
export function maintain(now = new Date()) {
  const today = zurichDate(now), yesterday = addDays(today, -1), hour = (now.getTime() - serviceBase(today)) / 3600_000;
  // yesterday's last trips run until ~03:00 today, so wait until 04:00 before summarising it
  const ready = (date: string) => date < yesterday || (date === yesterday && hour > 4);
  // a day only seen as the after-midnight tail of the first start (nothing observed) isn't a day of data
  const pending = (db.query("SELECT DISTINCT date FROM trip_day WHERE date < ? AND date NOT IN (SELECT date FROM agg_net_day)").all(today) as { date: string }[])
    .filter(({ date }) => ready(date) && db.query("SELECT 1 FROM trip_day WHERE date = ? AND observed = 1 LIMIT 1").get(date));
  for (const { date } of pending) aggregate(date);
  // night trains dated yesterday arrive until ~10:00 and are stored after that: summarise yesterday once more after 11:00
  if (hour > 11 && refreshed !== yesterday && !pending.length && db.query("SELECT 1 FROM agg_net_day WHERE date = ?").get(yesterday)) aggregate(yesterday);
  if (hour > 11) refreshed = yesterday;
  const cutoff = addDays(today, -KEEP_DAYS);
  db.query("DELETE FROM stop_obs WHERE date < ?").run(cutoff);
  db.query("DELETE FROM trip_day WHERE date < ?").run(cutoff);
  db.query("DELETE FROM vehicle_run WHERE date < ?").run(cutoff);
  db.query("DELETE FROM formation_cache WHERE date < ?").run(addDays(today, -3));
  db.query("DELETE FROM upstream_call WHERE t < ?").run(now.getTime() - 2 * 86400_000);
  db.query("DELETE FROM alert_entity WHERE last_seen < ?").run(now.getTime() / 1000 - KEEP_DAYS * 86400);
  db.query("DELETE FROM net_sample WHERE t < ?").run(serviceBase(cutoff) / 1000);
  db.query("DELETE FROM alert_log WHERE last_seen < ?").run(now.getTime() / 1000 - 365 * 86400);
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
    // delay gained between consecutive stops (arrival at b minus departure at a), per section and direction: the map's "where time is lost"
    db.query(`INSERT OR REPLACE INTO agg_seg_day SELECT x.date, x.uic, y.uic, count(*), sum(y.arr_delay - x.dep_delay) FROM stop_obs x
      JOIN stop_obs y ON y.date = x.date AND y.trip = x.trip AND y.idx = x.idx + 1
      WHERE x.date = ? AND x.dep_delay IS NOT NULL AND y.arr_delay IS NOT NULL AND x.skipped = 0 AND y.skipped = 0 GROUP BY x.uic, y.uic`).run(date);
  })();
  console.log(`[record] aggregated ${date}`);
}
