// Nightly crawl: the formation of every long-distance train today -> which physical trainset ran which train (vehicle_run).
import { db } from "./record";
import { EVU, formationFor, type Unit } from "./details";
import type { Day, Trip } from "./gtfs";

const LONG = /^(IC|ICE|ICN|EC|EN|NJ|TGV|RJ|RJX|IR|RE|PE)$/;
let running: string | null = null; // day version being crawled

/** Stop indexes a unit runs between (it may only cover part of the trip when trains split or join). */
export function unitSpan(trip: Trip, stationUic: (st: number) => string, u: Pick<Unit, "from" | "to">) {
  const uics = Array.from({ length: trip.stops.length / 3 }, (_, k) => stationUic(trip.stops[k * 3]));
  const a = Math.max(0, uics.indexOf(u.from)), b = uics.lastIndexOf(u.to);
  return [a, b > a ? b : uics.length - 1] as const;
}

export async function crawlFleet(d: Day) {
  if (running === d.version) return;
  running = d.version;
  // "not published" or already recorded today, also before a restart: never asked again.
  // A formation a visitor looked up is in the cache but not yet recorded: the crawl records it without a new request.
  const keys = (status: string) => new Set((db.query("SELECT key FROM formation_cache WHERE date = ? AND status = ?").all(d.date, status) as { key: string }[]).map((r) => r.key));
  const none = keys("none"), cached = keys("ok");
  const recorded = new Set((db.query("SELECT DISTINCT train_no FROM vehicle_run WHERE date = ?").all(d.date) as { train_no: string }[]).map((r) => r.train_no));
  const todo = new Map<string, Trip>();
  for (const t of d.trips) {
    const k = `${EVU[t.agency]}:${t.num}:${t.date}`;
    if (t.date === d.date && EVU[t.agency] && LONG.test(d.routes[t.route][1]) && !none.has(k) && !recorded.has(t.num) && !todo.has(k)) todo.set(k, t);
  }
  const ins = db.query("INSERT OR REPLACE INTO vehicle_run VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  const uic = (st: number) => d.stations[st][3], base = d.base / 1000;
  console.log(`[fleet] crawling ${todo.size} formations for ${d.date}`);
  let n = 0, units = 0;
  for (const [k, trip] of todo) {
    if (running !== d.version) return; // a new day started meanwhile
    const { status, f } = await formationFor(trip, { background: true }); // waits for slots visitors don't need
    if (status === "budget") return console.log(`[fleet] stopped at ${n}/${todo.size}: the day's share of the formation quota is used`);
    if (!cached.has(k)) await Bun.sleep(1500); // spread out, so a visitor rarely meets a full minute
    db.transaction(() => {
      f?.units.forEach((u, pos) => {
        const [a, b] = unitSpan(trip, uic, u);
        ins.run(d.date, u.id, u.cls, u.type, trip.num, trip.id, pos, u.from, u.to, base + trip.stops[a * 3 + 2], base + trip.stops[b * 3 + 1],
          +(trip.km[b] - trip.km[a]).toFixed(2), +u.length.toFixed(1), u.seats1, u.seats2, u.wr ? 1 : 0);
        units++;
      });
    })();
    if (++n % 250 === 0) console.log(`[fleet] ${n}/${todo.size} formations, ${units} unit runs`);
  }
  console.log(`[fleet] done: ${n} formations, ${units} unit runs`);
}
