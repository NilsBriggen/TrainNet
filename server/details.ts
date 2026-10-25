// Per-train extras: coach formation with vehicle identities (on demand + nightly crawl) and occupancy forecast (daily file).
import { rmSync } from "node:fs";
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

const WIKI = "https://en.wikipedia.org/wiki/";
/**
 * Train types by series (the 3 digits after the country code in an EVN: 94 85 x SSS NNN-c): the name passengers know,
 * a Wikipedia article for the full story, and one line of our own. Unlisted series fall back to the register's type name.
 */
export const TYPE_INFO: Record<string, { name: string; wiki?: string; about?: string }> = {
  "500": { name: "ICN", wiki: "SBB_RABDe_500", about: "Seven-car tilting InterCity train from around 2000, up to 200 km/h. Tilting lets it take curves faster, which is why it is at home on the winding Jura-foot line." },
  "501": { name: "Giruno", wiki: "Stadler_SMILE", about: "Stadler's high-speed train (SMILE), up to 250 km/h, with step-free boarding. Built for the Gotthard and Ceneri base tunnels and the services on to Milan." },
  "502": { name: "FV-Dosto", wiki: "SBB_RABe_502", about: "Double-deck intercity train by Bombardier (now Alstom), up to 200 km/h. Its roll compensation was meant to let it take curves faster." },
  "503": { name: "Astoro", wiki: "SBB_RABe_503", about: "Tilting high-speed train of the Pendolino family (ETR 610), up to 250 km/h, for EuroCity services between Switzerland and Italy." },
  "610": { name: "Astoro", wiki: "SBB_RABe_503", about: "Tilting high-speed train of the Pendolino family (ETR 610), up to 250 km/h, for EuroCity services between Switzerland and Italy." },
  "511": { name: "KISS", wiki: "Stadler_KISS", about: "Stadler double-deck multiple unit, up to 160 km/h, for RegioExpress and S-Bahn services." },
  "512": { name: "KISS", wiki: "Stadler_KISS", about: "Stadler double-deck multiple unit (the 'IR-Dosto'), up to 160 km/h, fitted out for longer InterRegio runs." },
  "514": { name: "DTZ", wiki: "SBB_RABe_514", about: "Siemens Desiro double-deck train built for the Zürich S-Bahn." },
  "515": { name: "MUTZ", wiki: "Stadler_KISS", about: "BLS double-deck S-Bahn train (Stadler KISS), the backbone of the Bern S-Bahn." },
  "521": { name: "FLIRT", wiki: "Stadler_FLIRT", about: "Stadler's single-deck regional train, the workhorse of many lines." },
  "522": { name: "FLIRT", wiki: "Stadler_FLIRT", about: "Multi-system Stadler FLIRT that can also run on French power, for lines into France." },
  "523": { name: "FLIRT", wiki: "Stadler_FLIRT", about: "Stadler's single-deck regional train, the workhorse of many S-Bahn and regional lines." },
  "524": { name: "FLIRT", wiki: "Stadler_FLIRT", about: "Stadler FLIRT for TILO, the Ticino S-Bahn that also runs into Lombardy." },
  "525": { name: "NINA", about: "Low-floor regional train of BLS." },
  "526": { name: "FLIRT", wiki: "Stadler_FLIRT", about: "Stadler FLIRTs of the Südostbahn, among them the 'Traverso' trains of the Voralpen-Express and the Treno Gottardo." },
  "527": { name: "FLIRT", wiki: "Stadler_FLIRT", about: "Stadler FLIRTs of regional railways: TPF around Fribourg and transN around Neuchâtel and La Chaux-de-Fonds." },
  "535": { name: "Lötschberger", about: "BLS regional train for the Lötschberg mountain line." },
  "460": { name: "Re 460", wiki: "SBB_Re_460", about: "SBB's standard electric locomotive since the 1990s, up to 230 km/h. It hauls the intercity coaches and IC2000 double-deck trains." },
  "465": { name: "Re 465", wiki: "BLS_Re_465", about: "BLS locomotive, the stronger sister of the Re 460, built for the Lötschberg gradients." },
  "474": { name: "Re 474", about: "Siemens multi-system locomotive (ES 64F4), mostly freight." },
  "475": { name: "Re 475", wiki: "Siemens_Vectron", about: "Siemens Vectron multi-system locomotive, mostly freight through the Alps." },
  "420": { name: "Re 420", wiki: "SBB_Re_4/4_II", about: "The classic Re 4/4 II, built from the 1960s on, in its time Switzerland's universal locomotive." },
  "450": { name: "Re 450", wiki: "SBB_Re_450", about: "S-Bahn locomotive for Zürich's double-deck push-pull trains." },
  "485": { name: "Re 485", wiki: "Bombardier_TRAXX", about: "Bombardier TRAXX locomotive, mostly freight." },
  "486": { name: "Re 486", wiki: "Bombardier_TRAXX", about: "Bombardier TRAXX multi-system locomotive, mostly freight." },
  "560": { name: "NPZ / Domino", wiki: "SBB_RBDe_560", about: "Regional multiple unit from the 1980s, many rebuilt as 'Domino' with a low-floor middle car." },
  // foreign units on Swiss trains (German ICEs to Basel and Zürich, DB locomotives on the Stuttgart line, TGV Lyria)
  "A116": { name: "ÖBB Taurus", wiki: "Siemens_ES64U2", about: "Siemens Taurus locomotive of the Austrian railways (Rh 1116), hauling the Railjet trains to Vienna." },
  // Rhaetian Railway (RhB): its own numbering, see rhbUnitOf
  "ABe416": { name: "Capricorn", wiki: "RhB_ABe_4/16_3111–3166", about: "Stadler's four-car metre-gauge multiple unit of the Rhaetian Railway, on RegioExpress and S-Bahn services around Chur and Landquart." },
  "ABe416A": { name: "Allegra ABe 4/16", wiki: "RhB_ABe_8/12", about: "Two-car version of the Allegra, for the Chur–Arosa line." },
  "ABe812": { name: "Allegra", wiki: "RhB_ABe_8/12", about: "Stadler's three-car multi-voltage unit of the Rhaetian Railway, built for the Bernina line's steep gradients and its DC power; it also pulls the Bernina Express." },
  "Ge443": { name: "Ge 4/4 III", wiki: "RhB_Ge_4/4_III", about: "The Rhaetian Railway's standard electric locomotive since the 1990s, often in advertising liveries; it hauls the Glacier Express and the Albula line trains." },
  "Ge442": { name: "Ge 4/4 II", wiki: "RhB_Ge_4/4_II", about: "Rhaetian Railway electric locomotive from the 1970s and 80s, for passenger and freight trains." },
  "Ge662": { name: "Ge 6/6 II", wiki: "RhB_Ge_6/6_II", about: "The Rhaetian Railway's heavy six-axle locomotive, mostly for freight." },
  "D412": { name: "ICE 4", wiki: "ICE_4", about: "Deutsche Bahn's newest ICE, on services from Germany into Switzerland." },
  "D406": { name: "ICE 3", wiki: "ICE_3", about: "Deutsche Bahn's multi-system high-speed train." },
  "D147": { name: "DB 147", wiki: "DB_Class_147", about: "Deutsche Bahn TRAXX locomotive, hauling the Stuttgart–Zürich intercity." },
  "F310": { name: "TGV Euroduplex", wiki: "TGV_2N2", about: "SNCF's double-deck TGV, run by TGV Lyria between Paris and Geneva, Lausanne, Basel and Zürich. Each set has a power car at either end, the units listed here." },
};
export const wikiOf = (cls: string) => (TYPE_INFO[cls]?.wiki ? WIKI + TYPE_INFO[cls].wiki : null);
let registerNames = new Map<string, string>(); // series -> type name from the rolling stock register, for series not listed above
export const setRegisterNames = (m: Map<string, string>) => (registerNames = m);
export const typeName = (cls: string) => TYPE_INFO[cls]?.name ?? registerNames.get(cls) ?? `Class ${cls}`;

/** The vehicle number as one string: the API gives it whole (evn) or, for some operators (TPF, RhB), only in parts. */
export const evnOf = (i: any): string => i?.evn ?? (i?.buildTypeCode && i?.countryCode && i?.vehicleNumber ? `${i.buildTypeCode}${i.countryCode}${i.vehicleNumber}${i.checkNumber ?? ""}` : "");

// RhB numbers its fleet its own way: 80 85 642 is the Ge 4/4 III 642; a multiple unit's cars are 80 85 TTTUU, car type
// TTT and unit UU (31045, 31645, 31745, 31845: Capricorn 3145; 35006, 35106, 35606: Allegra 3506); 91 85 … are coaches
const RHB_LOCOS: [number, number, string][] = [[611, 633, "Ge442"], [641, 652, "Ge443"], [701, 707, "Ge662"]];
export function rhbUnitOf(evn: string): { id: string; cls: string; type: string } | null {
  const d = evn.replace(/\D/g, "");
  if (!d.startsWith("8085")) return null;
  const num = +d.slice(4, -1), n = String(num); // without the check digit; the whole evn pads the number with zeros (80 85 0031045 9)
  const unit = (cls: string, no: number) => ({ id: `${cls}-${no}`, cls, type: typeName(cls) });
  for (const [lo, hi, cls] of RHB_LOCOS) if (num >= lo && num <= hi) return unit(cls, num);
  if (/^31\d{3}$/.test(n)) { const no = 3100 + +n.slice(3); return unit(no <= 3105 ? "ABe416A" : "ABe416", no); } // Allegra ABe 4/16 3101–3105, Capricorn from 3111
  if (/^35\d{3}$/.test(n)) return unit("ABe812", 3500 + +n.slice(3));
  return null;
}

// Foreign vehicles (country code after the type digits: 80 Germany, 81 Austria, 87 France) count as units only where we
// know the series as a trainset or locomotive: the same three digits mean something else in each country (a TGV's coaches,
// 93 87 3 147 …, aren't Deutsche Bahn's class 147 locomotive)
const FOREIGN: Record<string, string> = { "80:147": "D147", "80:412": "D412", "80:812": "D412", "80:406": "D406", "87:310": "F310", "81:116": "A116" };
// sets that number every car, its position first: the set is the last two digits (ICE 4 412 061 … 812 061 … 412 861 is
// set 61, SBB's ETR 610 cars 610 104 … 704 are set 04)
const BY_SET = new Set(["D412", "D406", "610"]);
/** Trainset or locomotive behind an EVN, e.g. "94 85 2 502 229-9" -> 502-229. Plain coaches (50/61/73 …) aren't units. */
export function unitOf(evn: string): { id: string; cls: string; type: string } | null {
  const d = evn.replace(/\D/g, "");
  if (d.length < 11 || d[0] !== "9") return null;
  const cc = d.slice(2, 4), series = d.slice(5, 8), cls = cc === "85" ? series : FOREIGN[`${cc}:${series}`];
  if (!cls) return null;
  return { id: `${cls}-${BY_SET.has(cls) ? d.slice(9, 11) : d.slice(8, 11)}`, cls, type: typeName(cls) };
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
  types?: { cls: string; type: string }[]; // no vehicle numbers published, but the car types name the train (a TGV's "ET(2N2)")
};
// car type codes that name a train's type when its vehicle numbers are missing
const TYPE_CODES: [RegExp, string][] = [[/\(2N2\)/, "F310"]];
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
export function parseFormation(j: any, evu = ""): Formation | null {
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
    const p = v.vehicleProperties ?? {}, evn = evnOf(v.vehicleIdentifier), u = evu === "RhB" ? rhbUnitOf(evn) : unitOf(evn);
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
  const types = units.size ? [] : [...new Set(vehicles.flatMap((v) => TYPE_CODES.filter(([re]) => re.test(v.vehicleIdentifier?.typeCodeName ?? "")).map(([, cls]) => cls)))];
  return { coaches, units: [...units.values()], stops, goals, ...(types.length && { types: types.map((cls) => ({ cls, type: typeName(cls) })) }) };
}

async function fetchFormation(evu: string, num: string, date: string, background: boolean): Promise<Formation | null> {
  const res = await upstream("FORMATION_SERVICE",
    `https://api.opentransportdata.swiss/formation/v2/formations_full?evu=${evu}&operationDate=${date}&trainNumber=${encodeURIComponent(num)}`,
    background ? { background } : { maxWait: 8000 }); // a visitor waits a few seconds at most, then hears why
  return parseFormation(await res.json(), evu);
}

// the cache holds parsed formations: a parser that reads more (vehicle numbers in parts, RhB's numbering) starts it over
const PARSED = 4; // 2: numbers in parts, RhB; 3: country codes, sets numbered car by car; 4: types from car codes
export const formationKey = (evu: string, num: string, date: string) => `${evu}:${num}:${date}:${PARSED}`;
const RETRY: Partial<Record<FormationStatus, number>> = { error: 120_000, none: 4 * 3600_000 }; // "none" can mean "not yet": ask again later
/** Formation of a trip: from the cache in stats.db (survives restarts), else fetched once. Permanent "none"s are cached for the day too. */
export function formationFor(trip: Trip, { fetch = true, background = false, allow = () => true } = {}): Promise<FormationResult> {
  const evu = EVU[trip.agency];
  if (!evu || !trip.num) return Promise.resolve({ status: "unsupported", f: null });
  const key = formationKey(evu, trip.num, trip.date);
  const row = db.query("SELECT status, t, json FROM formation_cache WHERE key = ?").get(key) as { status: FormationStatus; t: number; json: string | null } | null;
  if (row && !(Date.now() - row.t > (RETRY[row.status] ?? Infinity))) return Promise.resolve({ status: row.status, f: row.json ? JSON.parse(row.json) : null });
  if (trip.date < zurichDate(new Date())) return Promise.resolve({ status: "past", f: null }); // "dates older than today will not return results"
  if (!fetch) return Promise.resolve({ status: "window", f: null });
  if (!inflight.has(key)) {
    if (!allow()) return Promise.resolve({ status: "busy", f: null, retryAfter: 120 }); // this visitor's share of lookups is used up
    const store = (status: FormationStatus, f: Formation | null = null) => {
      db.query("INSERT OR REPLACE INTO formation_cache VALUES (?, ?, ?, ?, ?)").run(key, trip.date, status, Date.now(), f && JSON.stringify(f));
      return { status, f };
    };
    inflight.set(key, fetchFormation(evu, trip.num, trip.date, background)
      .then((f) => store(f ? "ok" : "none", f))
      .catch((e): FormationResult => {
        if (e instanceof Busy) return { status: "busy", f: null, retryAfter: e.retryAfter }; // not cached: nothing was asked
        if (e instanceof Budget) return { status: "budget", f: null };
        if (/HTTP 40[04]/.test(e.message)) return store("none"); // 400 "no formation data", 404 unknown
        // a 403 is the token (lapsed, or the API moved): an error to retry and to notice, never "not published"
        console.error(`[details] formation ${key}: ${e.message}${/HTTP 403/.test(e.message) ? " — check the FORMATION_SERVICE token" : ""}`);
        return store("error");
      })
      .finally(() => inflight.delete(key)));
  }
  return inflight.get(key)!;
}

export async function details(trip: Trip, base: number, allow?: () => boolean) {
  // an open endpoint must not let anyone drain the formation quota: only trains running around now are fetched
  const t = Date.now() / 1000 - base / 1000, s = trip.stops;
  const r = await formationFor(trip, { fetch: t >= s[2] - 3600 && t <= s[s.length - 2] + 2 * 3600, allow });
  return {
    formation: r.f?.coaches ?? null, units: r.f?.units ?? [], types: r.f?.types ?? [], stops: r.f?.stops ?? [], goals: r.f?.goals ?? [],
    formationStatus: r.status, retryAfter: r.retryAfter, occupancy: occupancy.get(`${trip.agency}:${trip.num}`)?.byStop ?? null,
  };
}

export const occupancyAll = () => occupancy;

let occDate = "", occTried = "", occTry = 0;
/** The date the loaded forecast is for ("" = none): the caller retries until it's today's. */
export const occupancyDate = () => occDate;

export async function loadOccupancy(date: string) {
  if (occTried === date && Date.now() - occTry < 3600_000) return; // a failed day is asked again hourly
  occTried = date;
  occTry = Date.now();
  if (occDate !== date) occupancy = new Map(); // yesterday's forecast would be wrong for today
  const { url } = await latestResource("occupancy-forecast-json-dataset");
  const zip = await download(url, `occupancy_${date}.zip`, "occupancy_");
  const list = (await new Response(Bun.spawn(["unzip", "-Z1", zip, `${date}/*`], { timeout: 120_000 }).stdout).text()).split("\n").filter(Boolean);
  if (!list.length) {
    rmSync(zip, { force: true }); // published before today's forecast was in it: download again on the next try
    throw new Error(`no forecast for ${date} in the published zip`);
  }
  const next: typeof occupancy = new Map();
  for (const file of list) {
    const j: any = JSON.parse(await new Response(Bun.spawn(["unzip", "-p", zip, file], { timeout: 120_000 }).stdout).text());
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
  occDate = date;
  console.log(`[details] occupancy for ${next.size} trains on ${date}`);
}
