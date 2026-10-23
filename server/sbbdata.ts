// Two open SBB datasets (data.sbb.ch, no token), refreshed weekly into stats.db:
// passengers per station (passagierfrequenz) and the rolling stock register (rollmaterial: build date, exact type per vehicle).
import { db } from "./record";
import { setRegisterNames, unitOf } from "./details";

const API = "https://data.sbb.ch/api/explore/v2.1/catalog/datasets";
const WEEK = 7 * 86400_000;

const exportJson = async (ds: string, select: string) => {
  const res = await fetch(`${API}/${ds}/exports/json?select=${encodeURIComponent(select)}`, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`${ds}: HTTP ${res.status}`);
  return (await res.json()) as any[];
};

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
  const last = (db.query("SELECT t FROM sbb_loaded WHERE name = 'all'").get() as { t: number } | null)?.t ?? 0;
  if (now - last < WEEK) return;
  const [pax, stock] = await Promise.all([
    exportJson("passagierfrequenz", "uic,jahr_annee_anno,dtv_tjm_tgm,dwv_tmjo_tfm"),
    exportJson("rollmaterial", "fahrzeug_nr_uic,fahrzeug_typ,baudatum_fahrzeug,sitzpl_1_kl_nr_r_total,sitzpl_2_kl_nr_r_total,lange_uber_zug,platze_rollstuhle_pro_zug"),
  ]);
  const n = importSbb(pax, stock);
  db.query("INSERT OR REPLACE INTO sbb_loaded VALUES ('all', ?)").run(now);
  useRegisterNames();
  console.log(`[sbbdata] passengers for ${n.stations} stations, ${n.units} trainsets and locomotives in the register`);
}

/** Register type names per series ("RABe 533" for 533), for series our own list doesn't name. Call after loading. */
export function useRegisterNames() {
  const rows = db.query("SELECT cls, subtype, count(*) n FROM rolling_stock WHERE subtype IS NOT NULL GROUP BY cls, subtype ORDER BY n").all() as { cls: string; subtype: string }[];
  // the most common subtype wins; trailing variant words ("IR200", "Evo41") are dropped: "RABe 502 IR200" -> "RABe 502"
  setRegisterNames(new Map(rows.map((r) => [r.cls, r.subtype.split(" ").slice(0, 2).join(" ")])));
}

/** Average daily passengers per station UIC (latest year), for map dot sizes and station pages. */
export const stationPax = () => db.query("SELECT uic, daily, year FROM station_pax").all() as { uic: string; daily: number; year: number }[];
