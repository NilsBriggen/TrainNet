// Open SBB datasets (data.sbb.ch, no token), refreshed weekly into stats.db: passengers per station (passagierfrequenz),
// the rolling stock register (rollmaterial: build date, exact type per vehicle) and where the sector signs stand on each
// platform (sektortafel), which tells which end of a train is the front.
import { db } from "./record";
import { setRegisterNames, unitOf } from "./details";

const API = "https://data.sbb.ch/api/explore/v2.1/catalog/datasets";
const WEEK = 7 * 86400_000;
const LOADED = "v2"; // bump when a dataset is added, so the next start loads all of them

const exportJson = async (ds: string, select: string) => {
  const res = await fetch(`${API}/${ds}/exports/json?select=${encodeURIComponent(select)}`, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`${ds}: HTTP ${res.status}`);
  return (await res.json()) as any[];
};

/** Where each sector of a platform is: the average position of its signs (a sign shows a letter on one or both faces). */
export function importSectors(signs: any[]) {
  const acc = new Map<string, { uic: string; track: string; sector: string; lon: number; lat: number; n: number }>();
  for (const r of signs) {
    const uic = String(r.bpuic ?? ""), track = String(r.kundengleisnummer ?? "").trim();
    if (!uic.startsWith("85") || !track || !r.geopos) continue;
    for (const sector of new Set([r.sektor_vorderseite, r.sektor_ruckseiter])) {
      if (!/^[A-Z]$/.test(sector ?? "")) continue;
      const k = `${uic}|${track}|${sector}`, x = acc.get(k) ?? acc.set(k, { uic, track, sector, lon: 0, lat: 0, n: 0 }).get(k)!;
      x.lon += r.geopos.lon; x.lat += r.geopos.lat; x.n++;
    }
  }
  db.transaction(() => {
    db.query("DELETE FROM platform_sector").run();
    const q = db.query("INSERT INTO platform_sector VALUES (?, ?, ?, ?, ?)");
    for (const x of acc.values()) q.run(x.uic, x.track, x.sector, x.lon / x.n, x.lat / x.n);
  })();
  return acc.size;
}

let ends = new Map<string, [number, number, number, number]>();
/** [lon, lat] of a platform's first and last sector ("A" and, say, "F"), keyed `${uic}|${track}`. Reload after importing. */
export function usePlatformEnds() {
  const rows = db.query("SELECT uic, track, sector, lon, lat FROM platform_sector ORDER BY uic, track, sector").all() as { uic: string; track: string; sector: string; lon: number; lat: number }[];
  const next = new Map<string, [number, number, number, number]>(), first = new Map<string, [number, number]>();
  for (const r of rows) {
    const k = `${r.uic}|${r.track}`;
    if (!first.has(k)) first.set(k, [r.lon, r.lat]);
    else next.set(k, [...first.get(k)!, r.lon, r.lat] as [number, number, number, number]); // rows are sorted: the last one wins
  }
  ends = next;
}
/** First and last sector of a platform, for "12" also trying "12A-C"-style names by their number. */
export const platformEnds = (uic: string, track: string) => ends.get(`${uic}|${track}`) ?? ends.get(`${uic}|${track.match(/^\d+/)?.[0] ?? ""}`) ?? null;

/** Latest year's average daily passengers per station; the register's trainsets keyed like our unit ids (502-206). */
export function importSbb(pax: any[], stock: any[]) {
  const latest = new Map<string, any>();
  for (const r of pax) {
    const uic = String(Math.round(r.uic ?? 0));
    if (uic.length === 7 && r.dtv_tjm_tgm && +r.jahr_annee_anno >= +(latest.get(uic)?.jahr_annee_anno ?? 0)) latest.set(uic, r);
  }
  const units = new Map<string, any>();
  for (const r of stock) {
    const u = unitOf(String(r.fahrzeug_nr_uic ?? ""));
    const seats = (r.sitzpl_1_kl_nr_r_total ?? 0) + (r.sitzpl_2_kl_nr_r_total ?? 0);
    // several register rows can share a unit id (single cars of a set): the one with the seats describes the set
    if (u && seats >= ((units.get(u.id)?.seats ?? -1))) units.set(u.id, { ...r, u, seats });
  }
  db.transaction(() => {
    const p = db.query("INSERT OR REPLACE INTO station_pax VALUES (?, ?, ?, ?)");
    for (const [uic, r] of latest) p.run(uic, +r.jahr_annee_anno, Math.round(r.dtv_tjm_tgm), Math.round(r.dwv_tmjo_tfm ?? r.dtv_tjm_tgm));
    const s = db.query("INSERT OR REPLACE INTO rolling_stock VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    for (const [id, r] of units) s.run(id, r.u.cls, r.fahrzeug_typ ?? null, r.baudatum_fahrzeug ?? null, r.sitzpl_1_kl_nr_r_total ?? null,
      r.sitzpl_2_kl_nr_r_total ?? null, r.lange_uber_zug ? r.lange_uber_zug / 1000 : null, r.platze_rollstuhle_pro_zug ?? null);
  })();
  return { stations: latest.size, units: units.size };
}

export async function loadSbbData(now = Date.now()) {
  const last = (db.query("SELECT t FROM sbb_loaded WHERE name = ?").get(LOADED) as { t: number } | null)?.t ?? 0;
  if (now - last < WEEK) return;
  const [pax, stock, signs] = await Promise.all([
    exportJson("passagierfrequenz", "uic,jahr_annee_anno,dtv_tjm_tgm,dwv_tmjo_tfm"),
    exportJson("rollmaterial", "fahrzeug_nr_uic,fahrzeug_typ,baudatum_fahrzeug,sitzpl_1_kl_nr_r_total,sitzpl_2_kl_nr_r_total,lange_uber_zug,platze_rollstuhle_pro_zug"),
    exportJson("sektortafel", "bpuic,kundengleisnummer,sektor_vorderseite,sektor_ruckseiter,geopos"),
  ]);
  const n = importSbb(pax, stock), sectors = importSectors(signs);
  db.query("INSERT OR REPLACE INTO sbb_loaded VALUES (?, ?)").run(LOADED, now);
  useRegisterNames();
  usePlatformEnds();
  console.log(`[sbbdata] passengers for ${n.stations} stations, ${n.units} trainsets and locomotives in the register, ${sectors} platform sectors`);
}

/** Register type names per series ("RABe 533" for 533), for series our own list doesn't name. Call after loading. */
export function useRegisterNames() {
  const rows = db.query("SELECT cls, subtype, count(*) n FROM rolling_stock WHERE subtype IS NOT NULL GROUP BY cls, subtype ORDER BY n").all() as { cls: string; subtype: string }[];
  // the most common subtype wins; trailing variant words ("IR200", "Evo41") are dropped: "RABe 502 IR200" -> "RABe 502"
  setRegisterNames(new Map(rows.map((r) => [r.cls, r.subtype.split(" ").slice(0, 2).join(" ")])));
}

/** Average daily passengers per station UIC (latest year), for map dot sizes and station pages. */
export const stationPax = () => db.query("SELECT uic, daily, year FROM station_pax").all() as { uic: string; daily: number; year: number }[];
