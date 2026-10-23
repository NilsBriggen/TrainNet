// Per-train extras: coach formation with vehicle identities (on demand + nightly crawl) and occupancy forecast (daily file).
import { upstream } from "./upstream";
import { download, latestResource } from "./gtfs";
import type { Trip } from "./gtfs";

// GTFS agency_id -> Formation Service EVU code. Others have no formation data.
export const EVU: Record<string, string> = { "11": "SBBP", "33": "BLSP", "65": "THURBO", "82": "SOB", "72": "RhB", "86": "ZB" };
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

export type Coach = { n: number | null; c: string; wr: boolean; bike: boolean; wc: boolean; closed: boolean; unit: string | null };
export type Unit = { id: string; cls: string; type: string; cars: number; length: number; seats1: number; seats2: number; wr: boolean; from: string; to: string };
export type Formation = { coaches: Coach[]; units: Unit[] };

const formations = new Map<string, Promise<Formation | null>>();
let occupancy = new Map<string, { byStop: Record<string, [number, number]>; sec: [string, number, number][] }>(); // "agency:train"

async function fetchFormation(evu: string, num: string, date: string): Promise<Formation | null> {
  const res = await upstream("FORMATION_SERVICE",
    `https://api.opentransportdata.swiss/formation/v1/formations_full?evu=${evu}&operationDate=${date}&trainNumber=${encodeURIComponent(num)}`);
  const j: any = await res.json();
  const vehicles: any[] = j.formations?.[0]?.formationVehicles ?? [];
  if (!vehicles.length) return null;
  const units = new Map<string, Unit>();
  const coaches = vehicles.sort((a, b) => a.position - b.position).map((v): Coach => {
    const p = v.vehicleProperties ?? {}, u = unitOf(v.vehicleIdentifier?.evn ?? "");
    const wr = p.numberRestaurantSpace > 0 || /^WR/.test(v.vehicleIdentifier?.typeCodeName ?? "");
    if (u) {
      const x = units.get(u.id) ?? { ...u, cars: 0, length: 0, seats1: 0, seats2: 0, wr: false, from: String(p.fromStop?.uic ?? ""), to: String(p.toStop?.uic ?? "") };
      x.cars++; x.length += p.length ?? 0; x.seats1 += p.number1class ?? 0; x.seats2 += p.number2class ?? 0; x.wr ||= wr;
      units.set(u.id, x);
    }
    return {
      n: v.number ?? null, c: (p.number1class ? "1" : "") + (p.number2class ? "2" : ""), wr,
      bike: p.numberBikeHooks > 0 || !!p.pictoProperties?.bikePicto,
      wc: (p.accessibilityProperties?.numberWheelchairSpaces ?? 0) > 0, closed: !!p.closed, unit: u?.id ?? null,
    };
  });
  return { coaches, units: [...units.values()] };
}

/** Formation of a trip, fetched once per train and day; shared by panel clicks and the nightly crawl. */
export function formationFor(trip: Trip, fetchIfMissing = true): Promise<Formation | null> {
  const evu = EVU[trip.agency];
  if (!evu || !trip.num) return Promise.resolve(null);
  const key = `${evu}:${trip.num}:${trip.date}`;
  if (!formations.has(key)) {
    if (!fetchIfMissing) return Promise.resolve(null);
    formations.set(key, fetchFormation(evu, trip.num, trip.date).catch((e) => {
      console.error(`[details] formation ${key}: ${e.message}`);
      setTimeout(() => formations.delete(key), 60_000); // retry after a minute, not on every click
      return null;
    }));
  }
  return formations.get(key)!;
}

export async function details(trip: Trip, base: number) {
  // an open endpoint must not let anyone drain the formation quota: only trains running around now are fetched
  const t = Date.now() / 1000 - base / 1000, s = trip.stops;
  const f = await formationFor(trip, t >= s[2] - 3600 && t <= s[s.length - 2] + 2 * 3600);
  return { formation: f?.coaches ?? null, units: f?.units ?? [], occupancy: occupancy.get(`${trip.agency}:${trip.num}`)?.byStop ?? null };
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
  formations.clear();
  console.log(`[details] occupancy for ${next.size} trains on ${date}`);
}
