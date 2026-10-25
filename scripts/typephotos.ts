// One-off, re-run when a type is added: a photo per train type from Wikimedia Commons (the type's Wikidata image), saved
// into public/types/ with its author and licence, so the pages show it without the visitor's browser asking Wikimedia.
//   bun scripts/typephotos.ts            (all types below)   bun scripts/typephotos.ts 502 511   (just these)
import { mkdirSync } from "node:fs";

// series -> what to look up on Wikidata (its English label; the first hit with an image wins), or a Commons file where
// Wikidata's image is GFDL (needs the licence text shown), missing, or a trade-fair shot
const TYPES: Record<string, string> = {
  "500": "File:I09 311 Bf Zürich HB, RABDe 500 xxx.jpg", "501": "File:SBB RABe 501 017.jpg", "502": "SBB RABe 502", "503": "SBB RABe 503", "610": "SBB RABe 503",
  "511": "SBB RABe 511", "512": "SBB RABe 512", "514": "SBB RABe 514", "515": "BLS RABe 515", "521": "SBB RABe 521",
  "522": "File:FFS RABe 522 205 Basel SBB 180611.jpg", "523": "SBB RABe 523", "524": "SBB RABe 524", "525": "BLS RABe 525", "526": "SOB RABe 526",
  "527": "File:TransN Flirt RABe 527 331 - Le Locle (28569273191).jpg", "535": "BLS RABe 535", "460": "SBB Re 460", "465": "BLS Re 465", "474": "SBB Re 474",
  "475": "File:BLS Re 475 402.jpg", "420": "SBB Re 4/4 II", "450": "SBB Re 450", "485": "BLS Re 485", "486": "BLS Re 486",
  "560": "File:SBB RBDe 560 Domino bei Sierre.jpg", "412": "ICE 4", "406": "ICE 3", "147": "DB Class 147", "310": "TGV 2N2",
};
const DIR = new URL("../public/types/", import.meta.url).pathname, OUT = `${DIR}photos.json`;
const UA = { "User-Agent": "TrainNet/0.1 (https://trainnet.briggen.dev; train type photos)" };
const get = async (url: string) => { const r = await fetch(url, { headers: UA }); if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r; };
const text = (html = "") => html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

async function fileInfo(file: string) {
  const page = Object.values((await (await get(`https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=640&titles=${encodeURIComponent(`File:${file}`)}`)).json()).query.pages)[0] as any;
  const ii = page.imageinfo?.[0], m = ii?.extmetadata ?? {};
  return ii?.thumburl ? { file, thumb: ii.thumburl, page: ii.descriptionurl, author: text(m.Artist?.value) || "unknown", licence: text(m.LicenseShortName?.value), licenceUrl: m.LicenseUrl?.value ?? "" } : null;
}

async function photoOf(query: string) {
  if (query.startsWith("File:")) { const f = await fileInfo(query.slice(5)); return f && { label: query, about: "", ...f }; }
  const hits = (await (await get(`https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&language=en&type=item&limit=5&search=${encodeURIComponent(query)}`)).json()).search ?? [];
  for (const h of hits) {
    const claims = (await (await get(`https://www.wikidata.org/w/api.php?action=wbgetclaims&format=json&property=P18&entity=${h.id}`)).json()).claims?.P18;
    const file = claims?.[0]?.mainsnak?.datavalue?.value;
    const f = file && (await fileInfo(file));
    if (f) return { label: h.label, about: h.description ?? "", ...f };
  }
  return null;
}

if (import.meta.main) {
  mkdirSync(DIR, { recursive: true });
  const all: Record<string, any> = (await Bun.file(OUT).exists()) ? await Bun.file(OUT).json() : {};
  const only = process.argv.slice(2);
  for (const [cls, query] of Object.entries(TYPES)) {
    if (only.length && !only.includes(cls)) continue;
    const p = await photoOf(query).catch((e) => (console.error(`${cls}: ${e.message}`), null));
    if (!p) { console.log(`${cls}: no photo for "${query}"`); continue; }
    if (!/^(CC BY|CC0|Public domain)/i.test(p.licence)) { console.log(`${cls}: ${p.file} is ${p.licence}, skipped`); continue; }
    await Bun.write(`${DIR}${cls}.jpg`, await (await get(p.thumb)).arrayBuffer());
    Bun.spawnSync(["magick", "mogrify", "-resize", "480x>", "-quality", "78", "-strip", `${DIR}${cls}.jpg`]); // ~40 KB instead of ~200
    all[cls] = { src: `/types/${cls}.jpg`, author: p.author, licence: p.licence, licenceUrl: p.licenceUrl, page: p.page };
    console.log(`${cls}: ${p.label} (${p.about}) — ${p.file} · ${p.author} · ${p.licence}`);
  }
  await Bun.write(OUT, JSON.stringify(all, null, 1));
}
