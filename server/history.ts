// Punctuality history from the official actual data (Ist-Daten): one CSV per day, a monthly zip archive back to 2018
// (archive.opentransportdata.swiss, no token) plus the last ~50 days on CKAN. Aggregated into hist_* tables as sums,
// so a day adds in once (hist_done) and months need no detail rows: 8 years stay at a few hundred MB.
import type { Database } from "bun:sqlite";
import { upstream } from "./upstream";
import { addDays, sane, zurichDate } from "./time";
import { lineKeys } from "./lines";

const LATE = 180; // punctual = less than 3 min late, the SBB threshold
export const ARCHIVE = "https://archive.opentransportdata.swiss";

export function initHistory(db: Database) {
  db.exec(`
CREATE TABLE IF NOT EXISTS hist_done (date TEXT PRIMARY KEY, trips INTEGER, t INTEGER);
CREATE TABLE IF NOT EXISTS hist_net_day (date TEXT PRIMARY KEY, trips INTEGER, observed INTEGER, punctual INTEGER, cancelled INTEGER, extra INTEGER,
  stop_obs INTEGER, stop_ok INTEGER, sum_final_delay INTEGER);
CREATE TABLE IF NOT EXISTS hist_line_month (month TEXT, line TEXT, cat TEXT, trips INTEGER, observed INTEGER, punctual INTEGER, cancelled INTEGER,
  sum_final_delay INTEGER, PRIMARY KEY (month, line));
CREATE TABLE IF NOT EXISTS hist_station_month (month TEXT, uic TEXT, name TEXT, deps INTEGER, dep_obs INTEGER, dep_ok INTEGER, sum_dep_delay INTEGER,
  PRIMARY KEY (month, uic));
CREATE TABLE IF NOT EXISTS hist_train_month (month TEXT, train_no TEXT, line TEXT, trips INTEGER, observed INTEGER, punctual INTEGER, cancelled INTEGER,
  sum_final_delay INTEGER, max_delay INTEGER, PRIMARY KEY (month, train_no, line));
CREATE INDEX IF NOT EXISTS hist_train_no ON hist_train_month (train_no);
CREATE INDEX IF NOT EXISTS hist_station_uic ON hist_station_month (uic);
CREATE INDEX IF NOT EXISTS hist_line_line ON hist_line_month (line);
CREATE TABLE IF NOT EXISTS hist_hour_month (month TEXT, dow INTEGER, hour INTEGER, n INTEGER, late INTEGER, sum_delay INTEGER, PRIMARY KEY (month, dow, hour));
`);
}

/** "01.09.2026 06:47" or "01.09.2026 06:47:30" → seconds on a local-time scale (only differences and the hour are used). */
const secs = (s: string) => Date.UTC(+s.slice(6, 10), +s.slice(3, 5) - 1, +s.slice(0, 2), +s.slice(11, 13), +s.slice(14, 16), s.length > 16 ? +s.slice(17, 19) : 0) / 1000;
const isoDay = (ddmmyyyy: string) => `${ddmmyyyy.slice(6, 10)}-${ddmmyyyy.slice(3, 5)}-${ddmmyyyy.slice(0, 2)}`;

type Trip = { name: string; cat: string; no: string; extra: boolean; rows: number; cancelledRows: number; lastArr: number; lastAct: number | null; max: number; uics: string[] };

/**
 * One day's CSV (any year's format: columns are found by name) as a stream of bytes. Keeps trains at Swiss stops.
 * Per train: final delay at its last Swiss stop with an arrival; observed = that stop has an actual/forecast time;
 * cancelled = every Swiss stop cancelled. Per stop departure: delay by station and by weekday × hour.
 * Delay sums count early as 0, so early trains don't cancel out late ones in an average.
 */
export async function importDay(db: Database, body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>, expectDate?: string) {
  const trips = new Map<string, Trip>();
  const stations = new Map<string, { name: string; deps: number; obs: number; ok: number; sum: number }>();
  const hours = new Map<number, { n: number; late: number; sum: number }>();
  let col: Record<string, number> | null = null, date = "", stopObs = 0, stopOk = 0;
  const dec = new TextDecoder();
  let buf = "";
  const row = (line: string) => {
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (!line) return;
    if (!col) return void (col = Object.fromEntries(line.replace(/^﻿/, "").split(";").map((h, i) => [h.trim(), i])));
    if (!line.includes(";Zug;") && !line.includes(";zug;")) return; // cheap: most rows are buses and trams
    const c = line.split(";");
    const uic = c[col.BPUIC];
    if (c[col.PRODUKT_ID].toLowerCase() !== "zug" || !uic?.startsWith("85")) return; // Swiss stops only (the feed also lists the foreign part)
    date ||= isoDay(c[col.BETRIEBSTAG]);
    const id = c[col.FAHRT_BEZEICHNER], cancelled = c[col.FAELLT_AUS_TF] === "true", pass = c[col.DURCHFAHRT_TF] === "true";
    let t = trips.get(id);
    if (!t) trips.set(id, (t = { name: c[col.LINIEN_TEXT], cat: c[col.VERKEHRSMITTEL_TEXT], no: c[col.LINIEN_ID], extra: c[col.ZUSATZFAHRT_TF] === "true", rows: 0, cancelledRows: 0, lastArr: -1, lastAct: null, max: 0, uics: [] }));
    if (pass) return;
    t.rows++;
    t.uics.push(uic);
    if (cancelled) return void t.cancelledRows++;
    const arr = c[col.ANKUNFTSZEIT], arrAct = c[col.AN_PROGNOSE];
    if (arr) {
      const s = secs(arr), raw = arrAct ? secs(arrAct) - s : null, d = raw !== null && sane(raw) ? raw : null;
      if (d !== null) t.max = Math.max(t.max, d);
      if (s >= t.lastArr) { t.lastArr = s; t.lastAct = d; }
    }
    const dep = c[col.ABFAHRTSZEIT], depAct = c[col.AB_PROGNOSE];
    if (dep) {
      const st = stations.get(uic) ?? stations.set(uic, { name: c[col.HALTESTELLEN_NAME], deps: 0, obs: 0, ok: 0, sum: 0 }).get(uic)!;
      st.deps++;
      const d = depAct ? secs(depAct) - secs(dep) : NaN;
      if (sane(d)) {
        st.obs++; st.sum += Math.max(0, d);
        if (d < LATE) st.ok++;
        stopObs++;
        if (d < LATE) stopOk++;
        const dow = (new Date(`${isoDay(dep)}T12:00:00Z`).getUTCDay() + 6) % 7, key = dow * 24 + +dep.slice(11, 13);
        const h = hours.get(key) ?? hours.set(key, { n: 0, late: 0, sum: 0 }).get(key)!;
        h.n++; h.sum += Math.max(0, d);
        if (d >= LATE) h.late++;
      }
    }
  };
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    buf += dec.decode(chunk, { stream: true });
    let start = 0, i;
    while ((i = buf.indexOf("\n", start)) >= 0) { row(buf.slice(start, i)); start = i + 1; }
    buf = buf.slice(start);
  }
  row(buf);
  if (!date) throw new Error(`no train rows${expectDate ? ` for ${expectDate}` : ""}`);
  if (expectDate && date !== expectDate) throw new Error(`file is for ${date}, expected ${expectDate}`);
  if (db.query("SELECT 1 FROM hist_done WHERE date = ?").get(date)) return { date, trips: 0, skipped: true };

  const month = date.slice(0, 7), list = [...trips.values()].filter((t) => t.rows); // trains only passing through: not counted
  const pax = new Map<string, number>();
  try { for (const r of db.query("SELECT uic, daily FROM station_pax").all() as { uic: string; daily: number }[]) pax.set(r.uic, r.daily); } catch {} // a fresh rebuild file may not have it
  const keys = lineKeys(list.map((t) => ({ name: t.name, cat: t.cat, uics: t.uics })), (u) => pax.get(u) ?? 0);
  db.transaction(() => {
    const net = { trips: 0, observed: 0, punctual: 0, cancelled: 0, extra: 0, sum: 0 };
    const lines = new Map<string, { cat: string; trips: number; obs: number; ok: number; canc: number; sum: number }>();
    const trains = new Map<string, { line: string; no: string; trips: number; obs: number; ok: number; canc: number; sum: number; max: number }>();
    list.forEach((t, i) => {
      const line = keys[i], canc = t.cancelledRows === t.rows, obs = !canc && t.lastAct !== null, ok = obs && t.lastAct! < LATE, final = obs ? Math.max(0, t.lastAct!) : 0;
      net.trips++; net.observed += +obs; net.punctual += +ok; net.cancelled += +canc; net.extra += +t.extra; net.sum += final;
      const l = lines.get(line) ?? lines.set(line, { cat: t.cat, trips: 0, obs: 0, ok: 0, canc: 0, sum: 0 }).get(line)!;
      l.trips++; l.obs += +obs; l.ok += +ok; l.canc += +canc; l.sum += final;
      const k = `${t.no}|${line}`, tr = trains.get(k) ?? trains.set(k, { line, no: t.no, trips: 0, obs: 0, ok: 0, canc: 0, sum: 0, max: 0 }).get(k)!;
      tr.trips++; tr.obs += +obs; tr.ok += +ok; tr.canc += +canc; tr.sum += final; tr.max = Math.max(tr.max, obs ? t.max : 0);
    });
    db.query("INSERT OR REPLACE INTO hist_net_day VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(date, net.trips, net.observed, net.punctual, net.cancelled, net.extra, stopObs, stopOk, net.sum);
    const ql = db.query(`INSERT INTO hist_line_month VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) ON CONFLICT DO UPDATE SET
      trips = trips + ?4, observed = observed + ?5, punctual = punctual + ?6, cancelled = cancelled + ?7, sum_final_delay = sum_final_delay + ?8`);
    for (const [line, l] of lines) ql.run(month, line, l.cat, l.trips, l.obs, l.ok, l.canc, l.sum);
    const qt = db.query(`INSERT INTO hist_train_month VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) ON CONFLICT DO UPDATE SET
      trips = trips + ?4, observed = observed + ?5, punctual = punctual + ?6, cancelled = cancelled + ?7, sum_final_delay = sum_final_delay + ?8, max_delay = max(max_delay, ?9)`);
    for (const t of trains.values()) qt.run(month, t.no, t.line, t.trips, t.obs, t.ok, t.canc, t.sum, t.max);
    const qs = db.query(`INSERT INTO hist_station_month VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT DO UPDATE SET
      name = ?3, deps = deps + ?4, dep_obs = dep_obs + ?5, dep_ok = dep_ok + ?6, sum_dep_delay = sum_dep_delay + ?7`);
    for (const [uic, s] of stations) qs.run(month, uic, s.name, s.deps, s.obs, s.ok, s.sum);
    const qh = db.query(`INSERT INTO hist_hour_month VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT DO UPDATE SET n = n + ?4, late = late + ?5, sum_delay = sum_delay + ?6`);
    for (const [k, h] of hours) qh.run(month, Math.floor(k / 24), k % 24, h.n, h.late, h.sum);
    db.query("INSERT INTO hist_done VALUES (?, ?, ?)").run(date, net.trips, Date.now());
  })();
  return { date, trips: trips.size, skipped: false };
}

/** Every day member of a monthly archive zip, in order. */
export async function importMonthZip(db: Database, zip: string, log = console.log) {
  const list = await new Response(Bun.spawn(["unzip", "-Z1", zip]).stdout).text();
  for (const member of list.split("\n").filter((m) => m.endsWith(".csv")).sort()) {
    const m = member.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (m && db.query("SELECT 1 FROM hist_done WHERE date = ?").get(m[0])) continue; // done before (also by the daily import)
    const p = Bun.spawn(["unzip", "-p", zip, member], { stdout: "pipe" }), t0 = Date.now();
    const r = await importDay(db, p.stdout, m?.[0]);
    if ((await p.exited) !== 0) throw new Error(`unzip ${member} failed`);
    log(`[history] ${r.date}: ${r.trips} trains${r.skipped ? " (already imported)" : ""}, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }
}

/** The monthly archive: [{ month: "2018-01", url }], the v2 file where a month has both. The incomplete 2016/17 zip is left out. */
export async function listArchive(): Promise<{ month: string; url: string }[]> {
  const html = await (await fetch(`${ARCHIVE}/istdaten.php`, { signal: AbortSignal.timeout(60_000) })).text();
  const best = new Map<string, string>();
  for (const path of new Set(html.match(/istdaten\/\d{4}\/[^"'<> ]+\.zip/g) ?? [])) {
    const f = path.split("/").pop()!, m = f.match(/^(\d{2})_(\d{2})\.zip$/) ?? f.match(/(\d{4})-(\d{2})\.zip$/);
    if (!m) continue;
    const month = `${m[1].length === 2 ? `20${m[1]}` : m[1]}-${m[2]}`;
    if (!best.has(month) || f.includes("-v2-")) best.set(month, `${ARCHIVE}/${path}`);
  }
  return [...best].map(([month, url]) => ({ month, url })).sort((a, b) => a.month.localeCompare(b.month));
}

let lastTry = 0, busy = false;
const failed = new Map<string, number>(); // date -> when its import last failed
/**
 * Days on CKAN (the last ~50, published the next morning) not imported yet, oldest first; at most one attempt per hour.
 * Streams each CSV (~650 MB) straight from the download: nothing lands on disk.
 */
export async function importRecentDays(db: Database, now = Date.now()) {
  if (busy || now - lastTry < 3600_000) return; // a catch-up of many days can take longer than the hour
  lastTry = now;
  busy = true;
  try { await importAvailable(db, now); } finally { busy = false; }
}
async function importAvailable(db: Database, now: number) {
  const res = await upstream("CKAN", "https://api.opentransportdata.swiss/ckan-api/package_show?id=ist-daten-v2");
  const today = zurichDate(new Date(now)), first = (db.query("SELECT min(date) d FROM hist_done").get() as { d: string | null }).d ?? addDays(today, -60);
  const todo = ((await res.json()).result.resources as any[])
    .map((r) => ({ url: r.url as string, date: (r.url as string).match(/(\d{4}-\d{2}-\d{2})_istdaten\.csv$/)?.[1] }))
    .filter((r) => r.date && r.date < today && r.date >= first && !db.query("SELECT 1 FROM hist_done WHERE date = ?").get(r.date))
    .sort((a, b) => a.date!.localeCompare(b.date!));
  for (const r of todo) {
    if (now - (failed.get(r.date!) ?? 0) < 86400_000) continue; // a broken file is tried once a day, and doesn't hold up the rest
    try {
      const t0 = Date.now(), dl = await fetch(r.url, { signal: AbortSignal.timeout(30 * 60_000) });
      if (!dl.ok || !dl.body) throw new Error(`HTTP ${dl.status}`);
      const x = await importDay(db, dl.body, r.date);
      console.log(`[history] ${x.date}: ${x.trips} trains from the daily file, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    } catch (e: any) {
      failed.set(r.date!, now);
      console.error(`[history] ${r.date}: ${e.message}`);
    }
  }
}
