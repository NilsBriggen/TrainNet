// How a train pulls away and how fast it may go, by its rolling stock: a FLIRT accelerates twice as hard as a ten-coach
// InterCity. Multiple units by series (manufacturers' sheets, rounded): [starting acceleration m/s², top speed km/h].
// Locomotives as [tractive effort kN, mass t, top speed km/h]: a hauled train's acceleration comes from what it pulls.
const MU = {
  500: [0.7, 200], 501: [0.7, 250], 502: [0.8, 200], 503: [0.5, 250], 610: [0.5, 250], 511: [0.9, 200], 512: [0.9, 160], 514: [1.0, 140], 515: [1.0, 160],
  521: [1.2, 160], 522: [1.2, 160], 523: [1.2, 160], 524: [1.2, 160], 525: [1.1, 140], 526: [1.2, 160], 527: [1.2, 160], 535: [1.1, 160], 560: [0.9, 140],
  D412: [0.5, 250], D406: [0.6, 250], F310: [0.5, 250], ABe416: [0.9, 100], ABe416A: [0.9, 100], ABe812: [0.9, 100],
};
const LOCO = {
  460: [300, 84, 200], 465: [300, 84, 160], 420: [255, 80, 140], 450: [240, 78, 130], 474: [300, 86, 160], 475: [300, 86, 160], 485: [300, 86, 160], 486: [300, 86, 160],
  A116: [300, 86, 160], D147: [300, 86, 160], Ge443: [200, 62, 100], Ge442: [179, 50, 90], Ge662: [214, 65, 80],
};
const CAT = { long: [0.6, 200], ir: [0.8, 200], re: [1.0, 160], s: [1.1, 140], reg: [1.0, 120], priv: [0.9, 100], pe: [0.6, 100] }; // no formation known
const COACH_T = 45; // t, a coach with its passengers

/** { a0, b, vmax } (m/s², m/s², km/h) of a train made of these unit series hauling `coaches` cars, of category cat. */
export function traction(classes, coaches, cat) {
  const locos = classes.map((c) => LOCO[c]).filter(Boolean), mus = classes.map((c) => MU[c]).filter(Boolean);
  const b = cat === "long" || cat === "ir" ? 0.6 : 0.8; // service braking
  if (locos.length) {
    const F = locos.reduce((s, l) => s + l[0], 0), m = locos.reduce((s, l) => s + l[1], 0) + COACH_T * coaches;
    return { a0: Math.min(1, F / m), b, vmax: Math.min(...locos.map((l) => l[2])) }; // kN / t = m/s², at most adhesion
  }
  const [a0, vmax] = mus.length ? mus.reduce((x, y) => (y[0] < x[0] ? y : x)) : CAT[cat] ?? CAT.reg; // coupled units: the weakest sets the pace
  return { a0, b, vmax };
}
