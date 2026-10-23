// Line colours, shared by the map and the stats pages so a line looks the same everywhere.
const LONG = /^(IC|ICE|ICN|EC|EN|NJ|TGV|RJ|RJX)$/;

/** Style of a GTFS route: colour, size at country zoom, glow, chip key. cat = route_desc ("IC", "S", …), agency = agency_id. */
export function routeStyle(name, cat, agency) {
  if (LONG.test(cat)) return { c: "#ff3d5a", s: 1, glow: 1, cat: "long" };
  if (cat === "IR") return { c: "#ff9f1c", s: 0.85, glow: 0, cat: "ir" };
  if (cat === "PE") return { c: "#ffd166", s: 0.85, glow: 0, cat: "pe" };
  if (cat === "S" || cat === "SN") {
    const n = parseInt(name.replace(/\D/g, ""), 10) || name.length;
    return { c: `hsl(${(n * 67) % 360} 80% 68%)`, s: 0.65, glow: 0, cat: "s" };
  }
  if (cat === "RE") return { c: "#2ee6a6", s: 0.85, glow: 0, cat: "re" };
  return agency === "11" ? { c: "#5cc8ff", s: 0.65, glow: 0, cat: "reg" } : { c: "#c792ff", s: 0.65, glow: 0, cat: "priv" };
}

/** Colour from a line label alone ("IC5", "S12", "RE33"), for pages that don't know the route's category. */
export const lineColor = (line) => routeStyle(String(line), String(line).match(/^[A-Z]+/)?.[0] ?? "", "11").c;
