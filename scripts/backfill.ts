// One-off: import the Ist-Daten archive (one zip per month since 2018) into stats.db's hist_* tables.
// Resumable: days already imported are skipped. Zips stay in ARCHIVE_DIR/istdaten (the server's storage box), so a re-import downloads nothing.
//   docker exec -d trainnet sh -c 'bun scripts/backfill.ts 2018-01 >> /data/backfill.log 2>&1'
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { Database } from "bun:sqlite";
import { importMonthZip, initHistory, listArchive } from "../server/history";

const DATA = process.env.DATA_DIR ?? "data", DIR = `${process.env.ARCHIVE_DIR ?? DATA}/istdaten`;
const [from = "2018-01", to = "9999-12"] = process.argv.slice(2);
mkdirSync(DIR, { recursive: true });
const db = new Database(`${DATA}/stats.db`);
db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 10000;"); // the server writes to the same file meanwhile
initHistory(db);

const log = (s: string) => console.log(`${new Date().toISOString().slice(0, 19)} ${s}`);
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
