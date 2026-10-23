// Per-train extras: coach formation with vehicle identities (on demand + nightly crawl) and occupancy forecast (daily file).
import { Budget, Busy, upstream } from "./upstream";
import { db } from "./record";
import { download, latestResource } from "./gtfs";
import { zurichDate } from "./time";
import type { Trip } from "./gtfs";

// GTFS agency_id -> Formation Service EVU code (all 11 the service covers). Others have no formation data.
export const EVU: Record<string, string> = {
  "11": "SBBP", "33": "BLSP", "65": "THURBO", "82": "SOB", "72": "RhB", "86": "ZB", "29": "MBC", "53": "TPF",
  "44": "TRN", "73": "TRN", "153": "TRN", "81____": "OeBB", "817000": "OeBB", "9014": "VDBB",
};
const LEVEL: Record<string, number> = { manySeatsAvailable: 1, fewSeatsAvailable: 2, standingRoomOnly: 3 };

// series -> name; the 3 digits after the country code in an EVN (94 85 x SSS NNN-c)
const TYPES: Record<string, string> = {
  "500": "ICN", "501": "Giruno", "502": "FV-Dosto", "503": "Astoro", "511": "KISS", "512": "KISS", "514": "DTZ",
  "515": "MUTZ", "521": "FLIRT", "522": "FLIRT", "523": "FLIRT", "524": "FLIRT", "526": "FLIRT", "525": "NINA", "535": "Lötschberger",
  "460": "Re 460", "465": "Re 465", "474": "Re 474", "475": "Re 475", "420": "Re 420", "485": "Re 485", "486": "Re 486",
};
/** Trainset or locomotive behind an EVN, e.g. "94 85 2 502 229-9" -> 502-229. Plain coaches (50/61/73 …) aren't units. */
export function unitOf(evn: string): { id: string; cls: string; type: string } | null {
  const d = evn.replace(/\D/g, "");
  if (d.length < 11 || d[0] !== "9") return null;
  const cls = d.slice(5, 8);
  return { id: `${cls}-${d.slice(8, 11)}`, cls, type: TYPES[cls] ?? `Class ${cls}` };
}

export type Coach = {
  n: number | null; c: string; wr: boolean; bike: boolean; wc: boolean; closed: boolean; unit: string | null;
  low?: 1; fam?: 1; biz?: 1; wct?: 1; st?: string; // low floor, family zone, business zone, wheelchair toilet, unusual trolley status
  sec: string[]; // sector letters at each of Formation.stops ("" = not there)
};
export type Unit = { id: string; cls: string; type: string; cars: number; length: number; seats1: number; seats2: number; wr: boolean; from: string; to: string };
export type Formation = {
  coaches: Coach[]; units: Unit[];
  stops: { uic: string; track: string; moved: boolean }[]; // where the train calls, its platform, platform changed
  goals: [from: number, to: number, uic: string][]; // coach positions -> destination, when the train splits
};
/** ok: here it is · none: not published (yet) · unsupported: operator not in the service · window: only looked up around the trip
 * past: the service only answers for today, this run started yesterday · busy/budget: request quota (per minute / per day) in use
 * error: upstream failed, retried in 2 min */
export type FormationStatus = "ok" | "none" | "unsupported" | "window" | "past" | "busy" | "budget" | "error";
export type FormationResult = { status: FormationStatus; f: Formation | null; retryAfter?: number };

const inflight = new Map<string, Promise<FormationResult>>(); // one upstream call per train, however many ask at once
let occupancy = new Map<string, { byStop: Record<string, [number, number]>; sec: [string, number, number][] }>(); // "agency:train"

const TRACK_MOVED = 0b1111 << 4; // stopModifications bits #5–#8: track change on arrival or departure
const STATUS: Record<string, string> = {
  GeschlossenTechnisch: "closed", GeschlossenBetrieblich: "closed", RestaurantUnbedient: "restaurant not served",
  RestaurantUnbedientDeklassiert: "restaurant not served, open to all classes", Deklassiert: "open to all classes",
};

/** Parse a v2 formations_full response (v1 was switched off; the vehicle part kept its shape). */
export function parseFormation(j: any): Formation | null {
  const vehicles: any[] = j.formations?.[0]?.formationVehicles ?? [];
  if (!vehicles.length) return null;
  const atStops: any[] = j.formationsAtScheduledStops ?? [];
  const stops = atStops.map((x) => ({
    uic: String(x.scheduledStop?.stopPoint?.uic ?? ""), track: x.scheduledStop?.track && x.scheduledStop.track !== "N/A" ? String(x.scheduledStop.track) : "",
    moved: !!((x.scheduledStop?.stopModifications ?? 0) & TRACK_MOVED),
  }));
  const goals = (atStops[0]?.formationShort?.vehicleGoals ?? []).map((g: any) => [g.fromVehicleAtPosition, g.toVehicleAtPosition, String(g.destinationStopPoint?.uic ?? "")] as [number, number, string]);
  const units = new Map<string, Unit>();
  const coaches = vehicles.sort((a, b) => a.position - b.position).map((v): Coach => {
    const p = v.vehicleProperties ?? {}, u = unitOf(v.vehicleIdentifier?.evn ?? "");
    const wr = p.numberRestaurantSpace > 0 || /^WR/.test(v.vehicleIdentifier?.typeCodeName ?? "");
    if (u) {
      const x = units.get(u.id) ?? { ...u, cars: 0, length: 0, seats1: 0, seats2: 0, wr: false, from: String(p.fromStop?.uic ?? ""), to: String(p.toStop?.uic ?? "") };
      x.cars++; x.length += p.length ?? 0; x.seats1 += p.number1class ?? 0; x.seats2 += p.number2class ?? 0; x.wr ||= wr;
      units.set(u.id, x);
    }
    const ap = p.accessibilityProperties ?? {}, pp = p.pictoProperties ?? {}, at = new Map((v.formationVehicleAtScheduledStops ?? []).map((x: any) => [String(x.stopPoint?.uic), x.sectors]));
    return {
      n: v.number || null, c: (p.number1class ? "1" : "") + (p.number2class ? "2" : ""), wr,
      bike: p.numberBikeHooks > 0 || !!pp.bikePicto,
      wc: (ap.numberWheelchairSpaces ?? 0) > 0, closed: !!p.closed, unit: u?.id ?? null,
      ...(p.lowFloorTrolley && { low: 1 }), ...(pp.familyZonePicto && { fam: 1 }), ...(pp.businessZonePicto && { biz: 1 }), ...(ap.wheelchairToilet && { wct: 1 }),
      ...(STATUS[p.trolleyStatus] && { st: STATUS[p.trolleyStatus] }),
      sec: stops.map((x) => { const sc = at.get(x.uic) as string | undefined; return sc && sc !== "N/A" ? sc.replaceAll(",", "") : ""; }),
    };
  });
  return { coaches, units: [...units.values()], stops, goals };
}

async function fetchFormation(evu: string, num: string, date: string, background: boolean): Promise<Formation | null> {
  const res = await upstream("FORMATION_SERVICE",
    `https://api.opentransportdata.swiss/formation/v2/formations_full?evu=${evu}&operationDate=${date}&trainNumber=${encodeURIComponent(num)}`,
    background ? { background } : { maxWait: 8000 }); // a visitor waits a few seconds at most, then hears why
  return parseFormation(await res.json());
}

const RETRY: Partial<Record<FormationStatus, number>> = { error: 120_000, none: 4 * 3600_000 }; // "none" can mean "not yet": ask again later
/** Formation of a trip: from the cache in stats.db (survives restarts), else fetched once. Permanent "none"s are cached for the day too. */
export function formationFor(trip: Trip, { fetch = true, background = false } = {}): Promise<FormationResult> {
  const evu = EVU[trip.agency];
  if (!evu || !trip.num) return Promise.resolve({ status: "unsupported", f: null });
  const key = `${evu}:${trip.num}:${trip.date}`;
  const row = db.query("SELECT status, t, json FROM formation_cache WHERE key = ?").get(key) as { status: FormationStatus; t: number; json: string | null } | null;
  if (row && !(Date.now() - row.t > (RETRY[row.status] ?? Infinity))) return Promise.resolve({ status: row.status, f: row.json ? JSON.parse(row.json) : null });
  if (trip.date < zurichDate(new Date())) return Promise.resolve({ status: "past", f: null }); // "dates older than today will not return results"
  if (!fetch) return Promise.resolve({ status: "window", f: null });
  if (!inflight.has(key)) {
    const store = (status: FormationStatus, f: Formation | null = null) => {
      db.query("INSERT OR REPLACE INTO formation_cache VALUES (?, ?, ?, ?, ?)").run(key, trip.date, status, Date.now(), f && JSON.stringify(f));
      return { status, f };
    };
    inflight.set(key, fetchFormation(evu, trip.num, trip.date, background)
      .then((f) => store(f ? "ok" : "none", f))
      .catch((e): FormationResult => {
        if (e instanceof Busy) return { status: "busy", f: null, retryAfter: e.retryAfter }; // not cached: nothing was asked
        if (e instanceof Budget) return { status: "budget", f: null };
        if (/HTTP 40[034]/.test(e.message)) return store("none"); // 400 "no formation data", 403 not published, 404 unknown
        console.error(`[details] formation ${key}: ${e.message}`);
        return store("error");
      })
      .finally(() => inflight.delete(key)));
  }
  return inflight.get(key)!;
}

export async function details(trip: Trip, base: number) {
  // an open endpoint must not let anyone drain the formation quota: only trains running around now are fetched
  const t = Date.now() / 1000 - base / 1000, s = trip.stops;
  const r = await formationFor(trip, { fetch: t >= s[2] - 3600 && t <= s[s.length - 2] + 2 * 3600 });
  return {
    formation: r.f?.coaches ?? null, units: r.f?.units ?? [], stops: r.f?.stops ?? [], goals: r.f?.goals ?? [],
    formationStatus: r.status, retryAfter: r.retryAfter, occupancy: occupancy.get(`${trip.agency}:${trip.num}`)?.byStop ?? null,
  };
}

export const occupancyAll = () => occupancy;

export async function loadOccupancy(date: string) {
  const { url } = await latestResource("occupancy-forecast-json-dataset");
  const zip = await download(url, `occupancy_${date}.zip`, "occupancy_");
  const list = await new Response(Bun.spawn(["unzip", "-Z1", zip, `${date}/*`]).stdout).text();
  const next: typeof occupancy = new Map();
  for (const file of list.split("\n").filter(Boolean)) {
    const j: any = JSON.parse(await new Response(Bun.spawn(["unzip", "-p", zip, file]).stdout).text());
    for (const t of j.trains ?? []) {
      const byStop: Record<string, [number, number]> = {}, sec: [string, number, number][] = [];
      for (const s of t.sections ?? []) {
        const lv = (fc: string) => LEVEL[s.expectedDepartureOccupancies?.find((o: any) => o.fareClass === fc)?.occupancyLevel] ?? 0;
        byStop[s.departureStationId] = [lv("firstClass"), lv("secondClass")];
        sec.push([s.departureTime, lv("firstClass"), lv("secondClass")]);
      }
      next.set(`${j.operatorRef}:${t.trainNumber}`, { byStop, sec });
    }
  }
  occupancy = next;
  console.log(`[details] occupancy for ${next.size} trains on ${date}`);
}
