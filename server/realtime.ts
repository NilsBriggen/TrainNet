// Polls GTFS-RT (delays, cancellations) and GTFS-SA (disruptions); keeps the last good result.
// vendored from gtfs-realtime-bindings 1.1.1 (Apache-2.0): the package drags ~50 build-time packages into production
import GtfsRealtimeBindings from "./gtfs-realtime.js";
import { upstream } from "./upstream";
import { recordAlerts, recordTrips } from "./record";
import type { Day } from "./gtfs";

const { FeedMessage, TripUpdate, TripDescriptor } = GtfsRealtimeBindings.transit_realtime;
const RT_EVERY = 15_000; // 4/min of the 5/min limit, one spare
const SA_EVERY = 60_000; // the alerts feed is ~10 MB and changes slowly
const SUDDEN = 3600; // an incident blinks for its first hour

let delays: Record<number, { c?: 1; u?: (number | null)[][]; x?: number }> = {};
export type Alert = {
  id: string; h: string; d: string; u?: string; sev: 1 | 2 | 3; kind: string; why: string; cause: string; sudden?: 1; train?: 1;
  from: number; to: number; s: number[]; r: number[]; t: number[]; seg?: number[][];
};
let alerts: Alert[] = [];
// one sample per trip-update poll, 2 h: [feedTime, running, late ≥3 min, cancelled, stuck]
const stats: number[][] = [];
const STATS_KEEP = (2 * 3600_000) / RT_EVERY;
const hist = new Map<number, [number, number][]>(); // trip -> [feedTime, delay at next stop], last 6 min

// GTFS-SA carries no severity (effect is always UNKNOWN), so it comes from the wording.
// 3 = service interrupted now, 2 = limited/delays now, 1 = planned works, notices, resumed.
function severity(h: string, cause: string, activeNow: boolean): 1 | 2 | 3 {
  if (!activeNow || /CONSTRUCTION|MAINTENANCE/.test(cause)) return 1;
  if (/resumed|normalis|rétabli|ripristin|moved|verschoben|déplacé|spostat|time change|zeitumstellung/i.test(h)) return 1;
  if (/interrupt|unterbr|interromp|interru/i.test(h)) return 3;
  if (/limited|einschränk|restreint|limitat|delay|verspät|retard|ritard|cancel|ausf|supprim|soppress/i.test(h)) return 2;
  return 1;
}

const KINDS: [string, RegExp][] = [
  ["person", /person|people|personenunfall|accident involving|on the track/],
  ["signal", /signal|interlocking|points|switch|stellwerk|weiche|level crossing|barrier|aiguillage|enclenchement/],
  ["power", /overhead line|power|electric|catenary|fahrleitung|strom|ligne de contact/],
  ["train", /(fault|defect|problem|difficult\w*) (on|with|of) (a|the)? ?(train|vehicle|rolling)|defective (train|vehicle)|vehicle (fault|defect)|breakdown|fahrzeugstörung|panne/],
  ["infra", /infrastructure|track (damage|fault|defect)|damage to the track|rail break|route blocking|embankment|gleis/],
  ["weather", /storm|natural (hazard|event)|snow|weather|tree|landslide|flood|avalanche|rock|wind|unwetter|hail/],
  ["police", /police|emergency (services|operation)|fire|polizei|feuerwehr|rescue/],
];
/** What happened, from the "This is due to …." sentence and the header. */
export function classify(h: string, d: string, cause: string) {
  const why = d.match(/(?:due to|caused by)\s+(?:an?\s+|the\s+)?([^.]+?)\./i)?.[1]?.trim() ?? "";
  const text = `${h} ${why}`.toLowerCase();
  const kind = KINDS.find(([, re]) => re.test(text))?.[0]
    ?? (cause === "WEATHER" ? "weather" : /POLICE|MEDICAL/.test(cause) ? "police" : "other");
  return { why, kind };
}

const NOT_INCIDENT = /event|traffic|passenger|demand|construction|maintenance|engineering|elevator|wheelchair/i;
/** Just happened and unplanned: these blink on the map. Train-scoped incidents are promoted to "limited". */
export function markSudden(a: Alert, now: number) {
  if (!a.from || now - a.from > SUDDEN || /CONSTRUCTION|MAINTENANCE/.test(a.cause) || NOT_INCIDENT.test(`${a.h} ${a.why}`)) return;
  const trainScoped = a.t.length >= 1 && a.t.length <= 2 && !a.seg
    && (/TECHNICAL|ACCIDENT|MEDICAL|POLICE/.test(a.cause) || ["train", "person", "police"].includes(a.kind));
  if (trainScoped) { a.sev = Math.max(a.sev, 2) as 2 | 3; a.train = 1; } // the map makes those trains blink, not a place
  if (a.sev >= 2) a.sudden = 1;
}

/**
 * A train that's stuck: its predicted delay keeps rising while it should be moving.
 * Predictions change about once a minute, and one-off jumps are common, so a single rise means little.
 * Flags (returns the start time) on ≥3 rises totalling ≥150 s within 5 min with no real drop and ≥3 min late,
 * or on a single jump of ≥5 min. Clears after 3 min without a rise.
 */
export function stuck(h: [number, number][], now: number): number {
  const w = h.filter(([t]) => now - t <= 300);
  let ups = 0, growth = 0, maxDrop = 0, first = 0, lastUp = 0, jump = 0;
  for (let k = 1; k < w.length; k++) {
    const delta = w[k][1] - w[k - 1][1];
    if (delta > 0) { ups++; growth += delta; lastUp = w[k][0]; first ||= w[k][0]; }
    if (delta >= 300) jump = w[k][0];
    if (delta < 0) maxDrop = Math.max(maxDrop, -delta);
  }
  if (jump) return jump;
  const cur = w.at(-1)?.[1] ?? 0;
  return ups >= 3 && growth >= 150 && maxDrop <= 30 && cur >= 180 && now - lastUp <= 180 ? first : 0;
}

/**
 * Where an alert is: the "between A and B" span or the "at X" station of its header, else the two stations it names.
 * The entity list is unreliable (often the whole line's stops, or none), so the header wins.
 */
export function placeOf(h: string, entityStations: number[], byName: Map<string, number>): { pair?: [number, number]; at?: number } {
  const m = h.match(/(?:between|zwischen|entre|tra)\s+(.+?)\s+(?:and|und|et|e)\s+(.+?)\s*(?:\[|\.|$)/i);
  const pair = m ? [byName.get(m[1].toLowerCase()), byName.get(m[2].toLowerCase())] : entityStations.length === 2 ? entityStations : [];
  if (pair[0] !== undefined && pair[1] !== undefined && pair[0] !== pair[1]) return { pair: [pair[0], pair[1]] };
  const at = h.match(/\b(?:at|in|bei|à|a)\s+(.+?)\s*(?:\[|\.|$)/i), st = at ? byName.get(at[1].toLowerCase()) : undefined;
  return st === undefined ? {} : { at: st };
}

let feedTime = 0;
export let live = Bun.gzipSync("{}");

const decode = async (api: string, url: string) =>
  FeedMessage.decode(new Uint8Array(await (await upstream(api, url)).arrayBuffer()));

function publish(day: Day) {
  live = Bun.gzipSync(JSON.stringify({ v: day.version, time: feedTime, delays, alerts, stats }));
}

async function pollTrips(day: () => Day | undefined) {
  const d = day();
  if (!d) return;
  const feed = await decode("GTFS_RT", "https://api.opentransportdata.swiss/la/gtfs-rt");
  if (day() !== d) return; // a new day loaded while we downloaded: these trip indexes are stale
  const next: typeof delays = {};
  for (const e of feed.entity) {
    const tu = e.tripUpdate;
    const idx = tu && d.tripIndex.get(`${tu.trip.tripId}|${tu.trip.startDate}`);
    if (idx === undefined || !tu) continue; // ADDED trips aren't in the timetable: shortcut, not drawn
    if (tu.trip.scheduleRelationship === TripDescriptor.ScheduleRelationship.CANCELED) {
      next[idx] = { c: 1 };
      continue;
    }
    const trip = d.trips[idx];
    const u = (tu.stopTimeUpdate ?? []).flatMap((s) => {
      const pos = trip.seq.indexOf(s.stopSequence ?? -1);
      if (pos < 0) return [];
      // protobufjs puts proto2 defaults (0) on the prototype, so check for set fields explicitly
      const delay = (ev: any, sched: number) =>
        !ev ? null : Object.hasOwn(ev, "delay") ? ev.delay : Object.hasOwn(ev, "time") ? Number(ev.time) - (d.base / 1000 + sched) : null;
      const skip = s.scheduleRelationship === TripUpdate.StopTimeUpdate.ScheduleRelationship.SKIPPED ? 1 : 0;
      return [[pos, delay(s.arrival, trip.stops[pos * 3 + 1]), delay(s.departure, trip.stops[pos * 3 + 2]), skip]];
    });
    if (u.length) next[idx] = { u: u.sort((a, b) => a[0]! - b[0]!) };
  }
  delays = next;
  feedTime = Number(feed.header.timestamp);
  const [run, late, canc] = sample(d, feedTime - d.base / 1000, (i, dl) => {
    const h = hist.get(i) ?? [];
    h.push([feedTime, dl]);
    while (h.length && feedTime - h[0][0] > 360) h.shift();
    hist.set(i, h);
    const since = delays[i]?.u && !delays[i].c ? stuck(h, feedTime) : 0;
    if (since) delays[i].x = since;
  });
  for (const i of hist.keys()) if (!hist.get(i)!.length || feedTime - hist.get(i)!.at(-1)![0] > 60) hist.delete(i); // not running any more
  const nStuck = Object.values(delays).filter((v) => v.x).length;
  stats.push([feedTime, run, late, canc, nStuck]);
  if (stats.length > STATS_KEEP) stats.shift();
  recordTrips(d, delays, feedTime, [run, late, canc, nStuck]);
  publish(d);
}

/** [running, late, cancelled] at service-day second t; `each` gets the delay at every running trip's next stop. */
function sample(d: Day, t: number, each?: (i: number, delay: number) => void): [number, number, number] {
  let run = 0, late = 0, canc = 0;
  d.trips.forEach((trip, i) => {
    const s = trip.stops, u = delays[i]?.u;
    if (t < s[2] || t > s[s.length - 2] + 3 * 3600) return;
    let dl = 0, k = 0;
    for (let p = 0; p < s.length / 3; p++) { // carry the last update forward, like applyDelays() client-side
      while (k < (u?.length ?? 0) && u![k][0] < p) k++;
      if (u && k < u.length && u[k][0] === p) dl = u[k][1] ?? u[k][2] ?? dl;
      if (s[p * 3 + 1] + dl >= t) break;
    }
    if (t > s[s.length - 2] + dl) return;
    run++;
    if (delays[i]?.c) canc++;
    else if (dl >= 180) late++;
    each?.(i, dl);
  });
  return [run, late, canc];
}

async function pollAlerts(day: () => Day | undefined) {
  const d = day();
  if (!d) return;
  const feed = await decode("GTFS_SA", "https://api.opentransportdata.swiss/la/gtfs-sa");
  if (day() !== d) return; // a new day loaded while we downloaded: these trip indexes are stale
  const now = Date.now() / 1000;
  const text = (t: any) =>
    ((t?.translation?.find((x: any) => x.language === "en") ?? t?.translation?.[0])?.text ?? "").replace(/<[^>]*>/g, "");
  const next = new Map<string, Alert>(); // the feed repeats one message per affected entity group
  for (const e of feed.entity) {
    const a = e.alert;
    if (!a) continue;
    const period = (a.activePeriod ?? []).find((p) => Number(p.start ?? 0) <= now && (!p.end || now <= Number(p.end)));
    if (a.activePeriod?.length && !period) continue;
    const s = new Set<number>(), r = new Set<number>(), t = new Set<number>();
    for (const ie of a.informedEntity ?? []) {
      const st = ie.stopId ? d.stationOfStop(ie.stopId) : undefined;
      if (st !== undefined) s.add(st);
      const rt = ie.routeId ? d.routeIndex.get(ie.routeId) : undefined;
      if (rt !== undefined) r.add(rt);
      const tr = ie.trip?.tripId ? d.tripIndex.get(`${ie.trip.tripId}|${ie.trip.startDate || d.date.replaceAll("-", "")}`) : undefined;
      if (tr !== undefined) t.add(tr);
    }
    if (!s.size && !r.size && !t.size) continue; // not about rail
    // keyed by header + start, not description: the description carries the expected end, which SBB keeps moving
    const h = text(a.headerText), dsc = text(a.descriptionText), key = `${h}|${Number(period?.start ?? 0)}`, prev = next.get(key), u = text(a.url);
    const cause = String(GtfsRealtimeBindings.transit_realtime.Alert.Cause[a.cause as number] ?? a.cause ?? "");
    next.set(key, {
      id: Bun.hash(key).toString(36), h, d: dsc, u: /^https?:/.test(u) ? u : undefined,
      sev: severity(h, cause, !!period || !a.activePeriod?.length), cause, ...classify(h, dsc, cause),
      from: Number(period?.start ?? 0), to: Number(period?.end ?? 0),
      s: [...new Set([...(prev?.s ?? []), ...s])], r: [...new Set([...(prev?.r ?? []), ...r])], t: [...new Set([...(prev?.t ?? []), ...t])],
    });
  }
  alerts = [...next.values()];
  const byName = new Map(d.stations.map((s, i) => [s[0].toLowerCase(), i] as const));
  for (const a of alerts) {
    const place = placeOf(a.h, a.s, byName);
    if (place.pair) {
      const seg = d.track(...place.pair);
      if (seg) a.seg = [seg];
      a.s = place.pair; // the span's ends, not every stop of the affected trips
    } else if (place.at !== undefined) a.s = [place.at]; // a point alert: drawn as one marker
    markSudden(a, now);
  }
  alerts.sort((a, b) => (b.sudden ?? 0) - (a.sudden ?? 0) || b.sev - a.sev || b.from - a.from);
  recordAlerts(d, alerts, now);
  const n = alerts.filter((a) => a.sudden).length;
  if (n) console.log(`[realtime] ${n} sudden incident(s): ${alerts.filter((a) => a.sudden).map((a) => `${a.kind}: ${a.h.slice(0, 60)}`).join(" | ")}`);
  publish(d);
}

function loop(fn: () => Promise<void>, every: number, name: string) {
  const run = async () => {
    const t = Date.now();
    await fn().catch((e) => console.error(`[realtime] ${name}: ${e.message}`)); // keep last good data
    setTimeout(run, Math.max(0, every - (Date.now() - t)));
  };
  run();
}

export function startRealtime(day: () => Day | undefined) {
  loop(() => pollTrips(day), RT_EVERY, "trip updates");
  loop(() => pollAlerts(day), SA_EVERY, "alerts");
}

/** Drop realtime that refers to the previous day's trip indexes. */
export function resetRealtime(day: Day) {
  delays = {};
  alerts = [];
  hist.clear();
  publish(day);
}

/** Current state for the stats API. */
export const current = () => ({ delays, alerts, stats, feedTime });
