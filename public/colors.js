// Line colours, shared by the map and the stats pages so a line looks the same everywhere.
const LONG = /^(IC|ICE|ICN|EC|EN|NJ|TGV|RJ|RJX)$/;

/** A design token from style.css ("ok" → "#3ddc97"): the stylesheet is the one place colours are defined. */
export const token = (n) => getComputedStyle(document.documentElement).getPropertyValue(`--${n}`).trim();
/** Category colours (--cat-*). On the map every S-Bahn line has its own hue; `s` is the category's colour everywhere else. */
export const CAT = Object.fromEntries(["long", "ir", "re", "reg", "s", "priv", "pe"].map((k) => [k, token(`cat-${k}`)]));
/** Disruption severity, as the alerts feed's wording is read: [name, colour]. */
export const SEV = { 1: ["Planned", token("planned")], 2: ["Limited service", token("warn")], 3: ["Interrupted", token("very-late")] };

/** Style of a GTFS route: colour, size at country zoom, glow, chip key. cat = route_desc ("IC", "S", …), agency = agency_id. */
export function routeStyle(name, cat, agency) {
  if (LONG.test(cat)) return { c: CAT.long, s: 1, glow: 1, cat: "long" };
  if (cat === "IR") return { c: CAT.ir, s: 0.85, glow: 0, cat: "ir" };
  if (cat === "PE") return { c: CAT.pe, s: 0.85, glow: 0, cat: "pe" };
  if (cat === "S" || cat === "SN") {
    const n = parseInt(name.replace(/\D/g, ""), 10) || name.length;
    return { c: `hsl(${(n * 67) % 360} 80% 68%)`, s: 0.65, glow: 0, cat: "s" };
  }
  if (cat === "RE") return { c: CAT.re, s: 0.85, glow: 0, cat: "re" };
  return agency === "11" ? { c: CAT.reg, s: 0.65, glow: 0, cat: "reg" } : { c: CAT.priv, s: 0.65, glow: 0, cat: "priv" };
}

/** Colour from a line label alone ("IC5", "S12", "RE33"), for pages that don't know the route's category. */
export const lineColor = (line) => routeStyle(String(line), String(line).match(/^[A-Z]+/)?.[0] ?? "", "11").c;

// What the codes mean, for anyone who doesn't know Swiss train jargon: named trains (route names) first, then categories
const NAMED = {
  GPX: ["GoldenPass Express", "panorama train Montreux – Interlaken, changing gauge at Zweisimmen"],
  GEX: ["Glacier Express", "panorama train Zermatt – St. Moritz"],
  BEX: ["Bernina Express", "panorama train over the Bernina pass to Tirano"],
  LIX: ["Luzern–Interlaken Express", "over the Brünig pass"], IRLIX: ["Luzern–Interlaken Express", "over the Brünig pass"],
  IRLEX: ["Luzern–Engelberg Express", "InterRegio of the Zentralbahn"],
  VAE: ["Voralpen-Express", "St. Gallen – Luzern through the pre-Alps"],
};
const CATS = {
  IC: ["InterCity", "fast long-distance train, few stops"], ICN: ["InterCity", "tilting long-distance train"],
  IR: ["InterRegio", "fast train between regions, more stops than an InterCity"], RE: ["RegioExpress", "regional train that skips the smaller stations"],
  R: ["Regio", "regional train, stops at every station"], S: ["S-Bahn", "suburban train"], SN: ["Night S-Bahn", "suburban train on weekend nights"],
  EC: ["EuroCity", "international long-distance train"], EN: ["EuroNight", "international night train"], NJ: ["Nightjet", "night train of the Austrian railways (ÖBB)"],
  ICE: ["ICE", "high-speed train of Deutsche Bahn"], TGV: ["TGV Lyria", "French–Swiss high-speed train"],
  RJ: ["Railjet", "long-distance train of the Austrian railways (ÖBB)"], RJX: ["Railjet Xpress", "long-distance train of the Austrian railways (ÖBB)"],
  TER: ["TER", "French regional train"], RB: ["Regionalbahn", "German regional train"], IRE: ["InterRegio-Express", "German regional express"],
  EXT: ["Extra train", "special or additional service"], CC: ["Cog railway", "mountain railway with a rack between the rails"],
  PE: ["Panorama train", "scenic train with large windows"], ZUG: ["Train", ""],
};
/** [name, one line about it] for a route: "GPX" -> GoldenPass Express; Léman Express and night lines by their name pattern. */
export function trainKind(name, cat) {
  if (NAMED[name]) return NAMED[name];
  if (/^RL\d/.test(name)) return ["Léman Express", "cross-border S-Bahn around Geneva"];
  if (/^N\d/.test(name) && cat !== "S") return ["Night train", "weekend night service"];
  return CATS[cat] ?? ["", ""];
}
