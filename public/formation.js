// Why a train has no coach formation to show, by the server's formationStatus: the map's panel and the stats pages.
export const FORMATION_WHY = {
  none: () => "Not published for this train (or not yet: asked again in a few hours).",
  past: () => "Only available for today's trains; this run started yesterday.",
  unsupported: () => "This operator doesn't publish coach formations.",
  window: () => "Looked up from an hour before departure until two hours after arrival.",
  busy: (x) => `Lookups are busy right now (shared request quota). Retrying in ${Math.max(5, x.retryAfter ?? 20)} s…`,
  budget: () => "Today's formation lookups are used up (daily request quota). They reset at midnight.",
  error: () => "The formation service didn't answer. Trying again in a couple of minutes.",
  offline: () => "Couldn't reach the server. Trying again in a minute.",
};

// Side view of the actual consist for the train panel: each unit to scale by its length, its outline by series
const DOUBLE = new Set(["502", "511", "512", "514", "515", "F310"]), POINTED = new Set(["500", "501", "503", "610", "D406", "D412", "F310"]);
const LOCO = new Set(["loco", "460", "465", "474", "475", "420", "450", "485", "486", "A116", "D147", "Ge442", "Ge443", "Ge662"]);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/**
 * coaches: the coach strip ({ unit, c, wr } in order); units: [{ id, cls, type, cars, length, wr }]; colour: the line's.
 * Coaches of a unit draw as that unit; coaches without one (loco-hauled stock has no vehicle numbers) as a plain coach of
 * ~26.5 m, or a locomotive / driving car when it has no class. "" when there is nothing to draw.
 */
export function sideView(coaches, units, colour) {
  const byId = new Map(units.map((u) => [u.id, u])), seq = [];
  for (const c of coaches ?? []) {
    const u = c.unit && byId.get(c.unit);
    if (u) { if (seq.at(-1) !== u) seq.push(u); continue; }
    seq.push(c.c ? { cls: "coach", cars: 1, length: 26.5, wr: c.wr, type: c.wr ? "restaurant coach" : `${c.c.split("").join("/")}. class coach` } : { cls: "loco", cars: 1, length: 19, type: "locomotive or driving car" });
  }
  units = seq;
  const total = units.reduce((a, u) => a + (u.length || 0), 0);
  if (!units.length || !total) return "";
  // GAP: where one unit couples to the next; at least 200 m across, so a 74 m FLIRT looks short beside a 400 m IC
  const W = 360, GAP = 4, s = (W - 4 - GAP * (units.length - 1)) / Math.max(total, 200), base = 34, out = [];
  let x = 2;
  for (const u of units) {
    const w = (u.length || 0) * s, cars = Math.max(1, u.cars || 1), cw = w / cars, h = DOUBLE.has(u.cls) ? 26 : 18, loco = LOCO.has(u.cls), nose = POINTED.has(u.cls) ? Math.min(14, cw * 0.45) : loco ? 2 : 4;
    const parts = [];
    for (let c = 0; c < cars; c++) {
      const x0 = x + c * cw + 0.6, x1 = x + (c + 1) * cw - 0.6, first = c === 0, last = c === cars - 1, top = base - h;
      // a car: flat sides, the unit's two ends shaped by its nose (a cab at each end of every unit)
      const l = first ? nose : 1.5, r = last ? nose : 1.5;
      parts.push(`<path d="M${x0 + l} ${top} H${x1 - r} Q${x1} ${top} ${x1} ${top + Math.min(r, h / 2)} V${base} H${x0} V${top + Math.min(l, h / 2)} Q${x0} ${top} ${x0 + l} ${top} Z" class="sv-body"/>`);
      if (!loco) for (const row of DOUBLE.has(u.cls) ? [top + 5, top + 14] : [top + 5]) parts.push(`<rect x="${x0 + l + 1.5}" y="${row}" width="${Math.max(0, x1 - x0 - l - r - 3)}" height="4" rx="1" class="sv-win"/>`);
      parts.push(`<rect x="${x0}" y="${base - 4}" width="${x1 - x0}" height="1.6" fill="${esc(colour)}"/>`);
    }
    if (loco) parts.push(`<path d="M${x + w / 2 - 5} ${base - h} l3 -4 h4 l3 4" class="sv-panto"/>`);
    out.push(`<g data-w="${w.toFixed(1)}" data-h="${h}"><title>${esc([u.type, u.id, u.length ? `${Math.round(u.length)} m` : "", u.wr ? "restaurant" : ""].filter(Boolean).join(" · "))}</title>${parts.join("")}</g>`);
    x += w + GAP;
  }
  return `<svg class="sideview" viewBox="0 0 ${W} 40" role="img" aria-label="Side view of the train, to scale">${out.join("")}<line x1="0" y1="${base + 1}" x2="${W}" y2="${base + 1}" class="sv-rail"/></svg>`;
}
