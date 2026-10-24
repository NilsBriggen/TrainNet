// One-off: import the Ist-Daten archive (one zip per month since 2018) into stats.db's hist_* tables.
// Resumable: days already imported are skipped. Zips stay in ARCHIVE_DIR/istdaten (the server's storage box), so a re-import downloads nothing.
//   docker exec -d trainnet sh -c 'bun scripts/backfill.ts 2018-01 >> /data/backfill.log 2>&1'
// Rebuild (after an importer fix): import into a separate file, check it, then swap it in. The server re-imports the
// recent days from CKAN by itself afterwards (they aren't in the monthly archive yet).
//   docker exec -d trainnet sh -c 'bun scripts/backfill.ts 2018-01 --into /data/hist-new.db >> /data/backfill.log 2>&1'
//   docker exec trainnet bun scripts/backfill.ts --swap /data/hist-new.db      (after a snapshot of stats.db)
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { Database } from "bun:sqlite";
import { importMonthZip, initHistory, listArchive } from "../server/history";

const DATA = process.env.DATA_DIR ?? "data", DIR = `${process.env.ARCHIVE_DIR ?? DATA}/istdaten`, MAIN = `${DATA}/stats.db`;
const args = process.argv.slice(2), option = (name: string) => { const i = args.indexOf(name); return i < 0 ? null : args.splice(i, 2)[1]; };
const into = option("--into"), swap = option("--swap");
const [from = "2018-01", to = "9999-12"] = args;
const log = (s: string) => console.log(`${new Date().toISOString().slice(0, 19)} ${s}`);
const TABLES = ["hist_done", "hist_net_day", "hist_line_month", "hist_station_month", "hist_train_month", "hist_hour_month"];

if (swap) {
  // the rebuilt tables replace the old ones in one transaction: the stats pages see either the old or the new history
  const db = new Database(MAIN);
  db.exec("PRAGMA busy_timeout = 30000;");
  db.exec(`ATTACH '${swap}' AS n`);
  const days = (db.query("SELECT count(*) n FROM n.hist_done").get() as { n: number }).n;
  if (days < 3000) throw new Error(`${swap} has only ${days} days: not swapping`);
  db.transaction(() => {
    for (const t of TABLES) {
      db.exec(`DELETE FROM main.${t}`);
      db.exec(`INSERT INTO main.${t} SELECT * FROM n.${t}`);
    }
  })();
  db.exec("DETACH n");
  log(`[backfill] swapped in ${days} days from ${swap}`);
  process.exit(0);
}

mkdirSync(DIR, { recursive: true });
const db = new Database(into ?? MAIN);
db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 10000;"); // the server writes to the same file meanwhile
initHistory(db);
// line keys take the busiest station by passengers: a rebuild file needs that table too
if (into) {
  // read over a separate read-only connection: nothing here may write to the live database
  let pax: unknown[][] = [];
  try { pax = new Database(MAIN, { readonly: true }).query("SELECT uic, year, daily, weekday FROM station_pax").values(); } catch {}
  db.exec("CREATE TABLE IF NOT EXISTS station_pax (uic TEXT PRIMARY KEY, year INTEGER, daily INTEGER, weekday INTEGER); DELETE FROM station_pax;");
  const ins = db.query("INSERT INTO station_pax VALUES (?, ?, ?, ?)");
  db.transaction(() => { for (const r of pax) ins.run(...(r as [string, number, number, number])); })();
  if (!pax.length) log("[backfill] no passenger counts in stats.db: line hubs fall back to the most served station");
}
for (const { month, url } of (await listArchive()).filter((m) => m.month >= from && m.month <= to)) {
  const done = (db.query("SELECT count(*) n FROM hist_done WHERE date LIKE ?").get(`${month}-%`) as { n: number }).n;
  const days = new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 0)).getUTCDate();
  if (done >= days) continue;
  const zip = `${DIR}/${url.split("/").pop()}`, t0 = Date.now();
  if (!existsSync(zip)) {
    log(`[backfill] downloading ${url}`);
    const res = await fetch(url, { signal: AbortSignal.timeout(60 * 60_000) });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    await Bun.write(`${zip}.part`, res);
    renameSync(`${zip}.part`, zip);
  }
  await importMonthZip(db, zip, log);
  log(`[backfill] ${month} done in ${((Date.now() - t0) / 60_000).toFixed(1)} min`);
}
log("[backfill] finished");

// check report: months whose average delay can't be right, and days far below their neighbours
const odd = db.query(`SELECT substr(date, 1, 7) m, sum(sum_final_delay) * 1.0 / max(sum(observed), 1) avg FROM hist_net_day GROUP BY m HAVING avg < 0 OR avg > 300`).all();
const thin = db.query(`SELECT date, trips FROM hist_net_day WHERE trips < 8000 ORDER BY date`).all() as { date: string; trips: number }[];
log(`[backfill] check: ${(db.query("SELECT count(*) n FROM hist_done").get() as { n: number }).n} days; months with an odd average delay: ${JSON.stringify(odd)}`);
log(`[backfill] check: ${thin.length} thin days: ${thin.map((d) => `${d.date}:${d.trips}`).join(" ")}`);
log(`[backfill] check: categories among line keys: ${(db.query("SELECT count(DISTINCT line) n FROM hist_line_month WHERE line LIKE '%|'").get() as { n: number }).n}, lines: ${(db.query("SELECT count(DISTINCT line) n FROM hist_line_month WHERE line NOT LIKE '%|'").get() as { n: number }).n}`);
