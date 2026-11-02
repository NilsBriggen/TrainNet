// Formation crawl: every train of an operator in the formation service, shortly before it starts -> which physical
// trainset runs which train (vehicle_run), so a click finds the formation already there.
import { db } from "./record";
import { EVU, formationFor, formationKey, NONE_RETRY, type Unit } from "./details";
import type { Day, Trip } from "./gtfs";

const AHEAD = 90 * 60; // s before a train's first departure its formation is asked for
let latest = "", busy = false, last = 0; // newest day version asked for; a crawl running; when the last one started

/** Trips whose formation is due at `now` (s from the day's base): starting within AHEAD or running, soonest first. */
export const dueTrips = (trips: Trip[], date: string, now: number) =>
  trips.filter((t) => t.date === date && EVU[t.agency] && t.stops[2] - AHEAD <= now && now <= t.stops[t.stops.length - 2]).sort((a, b) => a.stops[2] - b.stops[2]);

/** Stop indexes a unit runs between (it may only cover part of the trip when trains split or join). */
export function unitSpan(trip: Trip, stationUic: (st: number) => string, u: Pick<Unit, "from" | "to">) {
  const uics = Array.from({ length: trip.stops.length / 3 }, (_, k) => stationUic(trip.stops[k * 3]));
  const a = Math.max(0, uics.indexOf(u.from)), b = uics.lastIndexOf(u.to);
  return [a, b > a ? b : uics.length - 1] as const;
}

/**
 * Called every 10 min: asks for the trains due (dueTrips), so each is asked about in the 90 min before it starts.
 * Formations get published late for some trains, so a "none" is asked again after an hour while the train is still
 * due; each pass also records what visitors looked up meanwhile. A new day stops an older crawl.
 */
export async function crawlFleet(d: Day) {
  const fresh = latest !== d.version;
  latest = d.version;
  if (busy) return;
  busy = true;
  const prev = fresh ? 0 : last;
  last = Date.now();
  try { await crawl(d, prev); } finally { busy = false; }
}

async function crawl(d: Day, prev: number) {
  // "not published" or already recorded today, also before a restart: never asked again.
  // A formation a visitor looked up is in the cache but not yet recorded: the crawl records it without a new request.
  const keys = (status: string, since = 0) => new Set((db.query("SELECT key FROM formation_cache WHERE date = ? AND status = ? AND t > ?").all(d.date, status, since) as { key: string }[]).map((r) => r.key));
  const none = keys("none", Date.now() - NONE_RETRY), cached = keys("ok"); // an older "none" may have been "not yet"
  // formations an earlier pass already went through: recorded, or without identifiable units (RhB coaches): nothing left to do
  const since = keys("ok", prev), handled = new Set([...cached].filter((k) => !since.has(k)));
  const agencyOf = new Map(d.trips.map((t) => [t.id, t.agency])); // the same number can run for two operators
  const recorded = new Set((db.query("SELECT DISTINCT train_no, trip FROM vehicle_run WHERE date = ?").all(d.date) as { train_no: string; trip: string }[]).map((r) => `${EVU[agencyOf.get(r.trip) ?? ""]}:${r.train_no}`));
  const todo = new Map<string, Trip>();
  for (const t of dueTrips(d.trips, d.date, Date.now() / 1000 - d.base / 1000)) {
    const k = formationKey(EVU[t.agency], t.num, t.date);
    if (!none.has(k) && !handled.has(k) && !recorded.has(`${EVU[t.agency]}:${t.num}`) && !todo.has(k)) todo.set(k, t);
  }
  const ins = db.query("INSERT OR REPLACE INTO vehicle_run VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  const uic = (st: number) => d.stations[st][3], base = d.base / 1000;
  if (!todo.size) return;
  console.log(`[fleet] crawling ${todo.size} formations for ${d.date}`);
  let n = 0, units = 0, errors = 0;
  for (const [k, trip] of todo) {
    if (latest !== d.version) return; // a new day started meanwhile
    const { status, f } = await formationFor(trip, { background: true }); // waits for slots visitors don't need
    if (status === "budget") return console.log(`[fleet] stopped at ${n}/${todo.size}: the day's share of the formation quota is used`);
    // the API is down: stop spending slots on it until the next pass
    if ((errors = status === "error" ? errors + 1 : 0) >= 5) return console.log(`[fleet] stopped at ${n}/${todo.size}: 5 errors in a row`);
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
