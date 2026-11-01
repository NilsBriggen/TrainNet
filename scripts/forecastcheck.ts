// Would a learned bias make the map's guess better? Leave one day out: learn each section's and stop's average forecast
// error from the other days, correct the held-out day with it, and compare with the feed's forecast as it is.
//   docker exec trainnet sh -c "cd /app && bun scripts/forecastcheck.ts /data"      (read-only)
import { Database } from "bun:sqlite";

type Row = { date: string; key: string; err: number }; // err = actual − forecast, seconds

/** Each row's error after subtracting its key's mean error over the other days (keys with < `min` such rows: uncorrected). */
export function leaveOneOut(rows: Row[], min = 20) {
  const all = new Map<string, [number, number]>(), byDay = new Map<string, [number, number]>();
  for (const r of rows) {
    const a = all.get(r.key) ?? all.set(r.key, [0, 0]).get(r.key)!, k = `${r.key}|${r.date}`, b = byDay.get(k) ?? byDay.set(k, [0, 0]).get(k)!;
    a[0] += r.err; a[1]++; b[0] += r.err; b[1]++;
  }
  return rows.map((r) => {
    const [s, n] = all.get(r.key)!, [sd, nd] = byDay.get(`${r.key}|${r.date}`)!;
    return n - nd >= min ? r.err - (s - sd) / (n - nd) : r.err;
  });
}
// self-check: a section always 60 s late on other days gets 60 s taken off; one seen too rarely stays as it is
{
  const rows = [...Array.from({ length: 3 }, (_, i) => ({ date: `d${i}`, key: "a", err: 60 })), { date: "d0", key: "b", err: 40 }];
  const out = leaveOneOut(rows, 2);
  if (out.join() !== "0,0,0,40") throw new Error(`leaveOneOut self-check failed: ${out}`);
}

const summary = (errs: number[]) => {
  const abs = errs.map(Math.abs);
  return `mean ${(abs.reduce((a, b) => a + b, 0) / Math.max(abs.length, 1)).toFixed(1)} s, within 30 s ${((100 * abs.filter((x) => x <= 30).length) / Math.max(abs.length, 1)).toFixed(1)} %`;
};

if (import.meta.main) {
  const db = new Database(`${process.argv[2] ?? process.env.DATA_DIR ?? "data"}/stats.db`, { readonly: true });
  const arr = db.query(`SELECT y.date, x.uic || '>' || y.uic key, y.arr_delay - y.arr_fc err FROM stop_obs x JOIN stop_obs y ON y.date = x.date AND y.trip = x.trip AND y.idx = x.idx + 1
    WHERE y.arr_fc IS NOT NULL AND y.arr_delay IS NOT NULL AND x.skipped = 0 AND y.skipped = 0`).all() as Row[];
  const dep = db.query(`SELECT date, uic key, dep_delay - dep_fc err FROM stop_obs WHERE dep_fc IS NOT NULL AND dep_delay IS NOT NULL AND skipped = 0`).all() as Row[];
  const days = new Set([...arr, ...dep].map((r) => r.date));
  console.log(`${days.size} days with forecasts recorded, ${arr.length} arrivals, ${dep.length} departures`);
  console.log(`arrivals   (forecast while running towards the stop): as the feed says: ${summary(arr.map((r) => r.err))} | with the section bias: ${summary(leaveOneOut(arr))}`);
  console.log(`departures (forecast while standing at the stop):     as the feed says: ${summary(dep.map((r) => r.err))} | with the stop bias:    ${summary(leaveOneOut(dep))}`);
  console.log(`together: as the feed says: ${summary([...arr, ...dep].map((r) => r.err))} | corrected: ${summary([...leaveOneOut(arr), ...leaveOneOut(dep)])}`);
}
