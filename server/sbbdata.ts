// Open SBB datasets (data.sbb.ch, no token), refreshed weekly into stats.db: passengers per station (passagierfrequenz)
// and through the day (bahnhofbenutzer-tagesverlauf), the rolling stock register (rollmaterial: build date, exact type per
// vehicle), where the sector signs stand on each platform (sektortafel: which end of a train is the front), every train
// per line section including freight (zugzahlen) and the platform edges' length and height (BehiG Haltekanten).
import { db } from "./record";
import { setRegisterNames, unitOf } from "./details";
import { segmentPaths, type Graph } from "./paths";

const API = "https://data.sbb.ch/api/explore/v2.1/catalog/datasets";
const WEEK = 7 * 86400_000;
const LOADED = "v3"; // bump when a dataset is added, so the next start loads all of them

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

/** Share of a station's daily users per hour, latest survey year per station. */
export function importBusyHours(rows: any[]) {
  const year = new Map<string, number>();
  for (const r of rows) { const u = String(r.bpuic), y = parseInt(String(r.jahr_annee_anno_year)); if (y > (year.get(u) ?? 0)) year.set(u, y); }
  db.transaction(() => {
    db.query("DELETE FROM station_hour").run();
    const q = db.query("INSERT OR REPLACE INTO station_hour VALUES (?, ?, ?, ?)");
    for (const r of rows) if (parseInt(String(r.jahr_annee_anno_year)) === year.get(String(r.bpuic))) q.run(String(r.bpuic), Math.round(r.uhrzeit) % 24, r.prozentsatz, year.get(String(r.bpuic))!);
  })();
  return year.size;
}

/** Trains per line section in the latest year, both directions together: all trains, freight trains, gross tonnes, energy. */
export function importSections(rows: any[]) {
  const year = Math.max(...rows.map((r) => parseInt(String(r.jahr)) || 0));
  const acc = new Map<string, any>();
  for (const r of rows) {
    if (parseInt(String(r.jahr)) !== year || !r.von_bpuic || !r.bis_bpuic) continue;
    const c = r.verbindung?.geometry?.coordinates ?? [], from = String(r.von_bpuic), to = String(r.bis_bpuic), flip = from > to;
    const [a, b] = flip ? [to, from] : [from, to], k = `${a}|${b}`;
    const x = acc.get(k) ?? acc.set(k, { a, b, trains: 0, freight: 0, tonnes: 0, kwh: 0, km: 0, line: r.strecke_bezeichnung,
      na: flip ? r.bp_bis_abschnitt_bezeichnung : r.bp_von_abschnitt_bezeichnung, nb: flip ? r.bp_von_abschnitt_bezeichnung : r.bp_bis_abschnitt_bezeichnung,
      pa: (flip ? c.at(-1) : c[0]) ?? [0, 0], pb: (flip ? c[0] : c.at(-1)) ?? [0, 0] }).get(k);
    x.trains += r.anzahl_zuege ?? 0; x.tonnes += r.gesamtbelastung_bruttotonnen ?? 0; x.kwh += r.stromverbrauch_auf_abschnitt ?? 0; x.km += r.trassenkilometer ?? 0;
    if (r.geschaeftscode === "Gueterverkehr") x.freight += r.anzahl_zuege ?? 0;
  }
  db.transaction(() => {
    db.query("DELETE FROM section_traffic").run();
    const q = db.query("INSERT INTO section_traffic VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const x of acc.values()) if (x.trains > 0) q.run(x.a, x.b, year, x.trains, x.freight, x.tonnes, x.kwh, x.km, x.na, x.nb, x.line, x.pa[0], x.pa[1], x.pb[0], x.pb[1]);
  })();
  return acc.size;
}

/** Platform edges (BehiG survey): length and height per station and customer track. UIC = 85 + the 5-digit DiDok number. */
export function importPlatformEdges(rows: any[]) {
  const acc = new Map<string, { uic: string; track: string; length: number; height: number | null; type: string }>();
  for (const r of rows) {
    const track = String(r.kundengleisnr ?? "").trim(), didok = String(r.didok ?? "").trim();
    if (!track || !/^\d{1,5}$/.test(didok)) continue;
    const uic = `85${didok.padStart(5, "0")}`, k = `${uic}|${track}`, h = String(r.konformitaet ?? "").match(/^P\s*(\d+)/)?.[1];
    const x = acc.get(k) ?? acc.set(k, { uic, track, length: 0, height: null, type: r.perrontyp ?? "" }).get(k)!;
    x.length = Math.max(x.length, r.perronkante_laenge ?? 0);
    x.height ??= h ? +h : null;
  }
  db.transaction(() => {
    db.query("DELETE FROM platform_edge").run();
    const q = db.query("INSERT INTO platform_edge VALUES (?, ?, ?, ?, ?)");
    for (const x of acc.values()) q.run(x.uic, x.track, Math.round(x.length), x.height, x.type);
  })();
  return acc.size;
}
let edges = new Map<string, { length: number; height: number | null }>();
export function usePlatformEdges() {
  edges = new Map((db.query("SELECT uic, track, length_m, height_cm FROM platform_edge").all() as any[]).map((r) => [`${r.uic}|${r.track}`, { length: r.length_m, height: r.height_cm }]));
}
/** A platform's edge length and height, for "12" also trying the number of "12A"-style names, like platformEnds. */
export const platformEdge = (uic: string, track: string) => edges.get(`${uic}|${track}`) ?? edges.get(`${uic}|${track.match(/^\d+/)?.[0] ?? ""}`) ?? null;

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
  const [pax, stock, signs, hours, sections, platforms] = await Promise.all([
    exportJson("passagierfrequenz", "uic,jahr_annee_anno,dtv_tjm_tgm,dwv_tmjo_tfm"),
    exportJson("rollmaterial", "fahrzeug_nr_uic,fahrzeug_typ,baudatum_fahrzeug,sitzpl_1_kl_nr_r_total,sitzpl_2_kl_nr_r_total,lange_uber_zug,platze_rollstuhle_pro_zug"),
    exportJson("sektortafel", "bpuic,kundengleisnummer,sektor_vorderseite,sektor_ruckseiter,geopos"),
    exportJson("anzahl-sbb-bahnhofbenutzer-tagesverlauf", "bpuic,uhrzeit,prozentsatz,jahr_annee_anno_year"),
    exportJson("zugzahlen", "von_bpuic,bis_bpuic,geschaeftscode,jahr,anzahl_zuege,gesamtbelastung_bruttotonnen,trassenkilometer,stromverbrauch_auf_abschnitt,bp_von_abschnitt_bezeichnung,bp_bis_abschnitt_bezeichnung,strecke_bezeichnung,verbindung"),
    exportJson("21197_behig-haltekantesegment", "didok,kundengleisnr,perronkante_laenge,konformitaet,perrontyp"),
  ]);
  const n = importSbb(pax, stock), sectors = importSectors(signs), busy = importBusyHours(hours), secs = importSections(sections), edgeCount = importPlatformEdges(platforms);
  db.query("INSERT OR REPLACE INTO sbb_loaded VALUES (?, ?)").run(LOADED, now);
  useRegisterNames();
  usePlatformEnds();
  usePlatformEdges();
  console.log(`[sbbdata] passengers for ${n.stations} stations (${busy} through the day), ${n.units} trainsets and locomotives in the register, ${sectors} platform sectors, ${edgeCount} platform edges, ${secs} line sections`);
}

/** Register type names per series ("RABe 533" for 533), for series our own list doesn't name. Call after loading. */
export function useRegisterNames() {
  const rows = db.query("SELECT cls, subtype, count(*) n FROM rolling_stock WHERE subtype IS NOT NULL GROUP BY cls, subtype ORDER BY n").all() as { cls: string; subtype: string }[];
  // the most common subtype wins; trailing variant words ("IR200", "Evo41") are dropped: "RABe 502 IR200" -> "RABe 502"
  setRegisterNames(new Map(rows.map((r) => [r.cls, r.subtype.split(" ").slice(0, 2).join(" ")])));
}

/** Average daily passengers per station UIC (latest year), for map dot sizes and station pages. */
export const stationPax = () => db.query("SELECT uic, daily, year FROM station_pax").all() as { uic: string; daily: number; year: number }[];

let sectionsGz: Uint8Array | null = null;
/** The line sections as GeoJSON on our own track (routed like the timetable's segments, same cache), gzipped for /api/sections. */
export async function buildSections(graph: Graph | null, cacheFile: string) {
  const rows = db.query("SELECT * FROM section_traffic").all() as any[];
  if (!rows.length) return;
  const points: { uic: string; lon: number; lat: number }[] = [], at = new Map<string, number>(), segs: number[] = [];
  const point = (uic: string, lon: number, lat: number) => at.get(uic) ?? (at.set(uic, points.push({ uic, lon, lat }) - 1), points.length - 1);
  for (const r of rows) segs.push(point(r.a, r.lon_a, r.lat_a), point(r.b, r.lon_b, r.lat_b));
  const { paths } = await segmentPaths(graph, segs, points, cacheFile);
  const features = rows.map((r, k) => {
    const p = paths[k] ?? [r.lon_a, r.lat_a, r.lon_b, r.lat_b], coords: number[][] = [];
    for (let i = 0; i < p.length; i += 2) coords.push([p[i], p[i + 1]]);
    return { type: "Feature", geometry: { type: "LineString", coordinates: coords },
      properties: { t: Math.round(r.trains / 365), f: r.trains ? Math.round((100 * r.freight) / r.trains) : 0, n: `${r.name_a} – ${r.name_b}`, y: r.year } };
  });
  sectionsGz = Bun.gzipSync(JSON.stringify({ type: "FeatureCollection", features }));
  console.log(`[sbbdata] ${rows.length} line sections drawn, ${paths.filter(Boolean).length} on track`);
}
export const sectionsBody = () => sectionsGz;
