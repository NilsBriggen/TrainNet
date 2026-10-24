import { expect, test } from "bun:test";
import Long from "long";
import { activeAt, classify, markSudden, observe, placeOf, resolveAlertIds, stuck, type Alert } from "../server/realtime";

test("classify reads the reason sentence from real feed texts", () => {
  expect(classify("Interrupted service on the Visp - Brig line between Visp and Brig [train]", "This is due to a defect in the overhead line. The restriction lasts until approx. 18:00.", "TECHNICAL_PROBLEM"))
    .toEqual({ why: "defect in the overhead line", kind: "power" });
  expect(classify("Limited service on the Lausanne - Genève line", "This is due to storm damage. The restriction lasts until approx. 19:00.", "WEATHER"))
    .toEqual({ why: "storm damage", kind: "weather" });
  expect(classify("Interrupted service between Olten and Aarau", "This is due to a person on the track.", "OTHER_CAUSE").kind).toBe("person");
  expect(classify("Limited service between Bern and Thun", "This is due to a signal fault.", "TECHNICAL_PROBLEM").kind).toBe("signal");
  expect(classify("Information on IC 1 727", "This is due to a technical fault on the train.", "TECHNICAL_PROBLEM").kind).toBe("train");
  expect(classify("Interrupted service", "This is due to technical difficulties on the infrastructure.", "TECHNICAL_PROBLEM").kind).toBe("infra");
  expect(classify("Interrupted service", "", "WEATHER")).toEqual({ why: "", kind: "weather" });
  // "personnel" is staff, not a person on the track
  expect(classify("Limited service between Palézieux and Vevey [train]", "This is due to a shortage of personnel.", "OTHER_CAUSE")).toEqual({ why: "shortage of personnel", kind: "staff" });
  expect(classify("Interrupted service between Olten and Aarau", "This is due to an accident involving a person.", "ACCIDENT").kind).toBe("person");
});

const now = 1_800_000_000;
const alert = (o: Partial<Alert>): Alert => ({ id: "x", h: "", d: "", sev: 2, kind: "other", why: "", cause: "OTHER_CAUSE", from: now - 300, to: 0, s: [], r: [], t: [], ...o });

test("sudden: recent, unplanned, live; not planned works, events, or old ones", () => {
  const storm = alert({ h: "Limited service on the Lausanne - Genève line", why: "storm damage", kind: "weather", cause: "WEATHER", seg: [[1, 2]] });
  markSudden(storm, now);
  expect(storm.sudden).toBe(1);
  expect(storm.train).toBeUndefined();
  for (const a of [
    alert({ cause: "CONSTRUCTION" }),
    alert({ why: "event HCC's game" }),
    alert({ from: now - 2 * 3600 }), // started 2 h ago: calm state now
    alert({ sev: 1 }),
    alert({ from: 0 }),
  ]) { markSudden(a, now); expect(a.sudden).toBeUndefined(); }
});

test("a train-scoped technical fault is promoted to limited and sudden", () => {
  const a = alert({ h: "Information on IC 1 727", sev: 1, cause: "TECHNICAL_PROBLEM", kind: "train", t: [42] });
  markSudden(a, now);
  expect(a).toMatchObject({ sev: 2, sudden: 1, train: 1 });
  const many = alert({ sev: 1, cause: "TECHNICAL_PROBLEM", kind: "train", t: [1, 2, 3, 4] }); // a whole line: not about one train
  markSudden(many, now);
  expect(many.sudden).toBeUndefined();
});

// samples every 15 s; upstream changes about once a minute
const series = (vals: number[]) => vals.map((v, k) => [now - (vals.length - 1 - k) * 15, v] as [number, number]);

test("stuck: sustained growth flags, from the first rise", () => {
  // RE33 18436 near Nyon, real sample: 1014 → 1110 → 1188 → 1230 → 1284
  const h = series([1014, 1110, 1110, 1110, 1110, 1188, 1188, 1188, 1230, 1230, 1230, 1284]);
  expect(stuck(h, now)).toBe(h[1][0]);
});

test("stuck: a single correction or a steady delay does not flag", () => {
  expect(stuck(series([6, 6, 246, 246, 246, 246, 246, 276, 276, 276]), now)).toBe(0); // one jump of 4 min, then flat
  expect(stuck(series([600, 600, 600, 600, 600, 600]), now)).toBe(0);
  expect(stuck(series([60, 90, 120, 150, 140]), now)).toBe(0); // only 2 min late
});

test("stuck: a single jump, even of 5+ min, is not enough; growth that stopped 3+ min ago clears", () => {
  expect(stuck(series([1518, 1518, 1992, 1992]), now)).toBe(0); // often one corrected data point
  const old = series([300, 400, 500, 600, ...Array(15).fill(600)]); // last rise 3:45 ago
  expect(stuck(old, now)).toBe(0);
});

test("stuck: passing stops with different delays is not a rise (IC51 1640: stop 7 at +90, stop 8 at +354)", () => {
  const h = new Map();
  const steps: [number, number][] = [[6, 30], [7, 90], [7, 90], [8, 354], [8, 354], [9, 420], [9, 420], [10, 480]];
  const flags = steps.map(([stop, d], k) => observe(h, 1, stop, d, now - (steps.length - 1 - k) * 15));
  expect(flags.every((f) => f === 0)).toBe(true);
  const same = new Map(); // the same delays while heading for one stop: standing
  const at = [1014, 1110, 1110, 1188, 1188, 1230, 1284].map((d, k, a) => observe(same, 1, 5, d, now - (a.length - 1 - k) * 15));
  expect(at.at(-1)).toBeGreaterThan(0);
});

test("a sudden storm alert naming two trips but no span is about the place, not those trains", () => {
  const a = alert({ h: "Limited service at Jenaz", why: "storm damage", kind: "weather", cause: "WEATHER", t: [1, 2], s: [7] });
  markSudden(a, now);
  expect(a.sudden).toBe(1);
  expect(a.train).toBeUndefined();
});

test("placeOf reads the span or the place from real headers", () => {
  const names = ["visp", "brig", "morges", "villeneuve vd", "interlaken west", "interlaken ost", "suhr", "jenaz"];
  const byName = new Map(names.map((n, i) => [n, i] as const));
  expect(placeOf("Interrupted service on the Visp - Brig line between Visp and Brig [train]", [], byName)).toEqual({ pair: [0, 1] });
  expect(placeOf("Limited service on the Genève - Brig line between Morges and Villeneuve VD [train]", [], byName)).toEqual({ pair: [2, 3] });
  expect(placeOf("Interrupted train service between Interlaken West and Interlaken Ost.", [], byName)).toEqual({ pair: [4, 5] });
  expect(placeOf("Limited service at Suhr [train]", [], byName)).toEqual({ at: 6 });
  expect(placeOf("Limited train services at Jenaz.", [], byName)).toEqual({ at: 7 });
  expect(placeOf("Information on IC 1 727", [3, 5], byName)).toEqual({ pair: [3, 5] }); // no span in the header: the two named stations
  expect(placeOf("Interrupted service between Nowhere and Elsewhere [train]", [], byName)).toEqual({});
});

test("an alert with no end (decoded as Long 0) is active", () => {
  const open = { start: Long.fromNumber(now - 600, true), end: Long.fromNumber(0, true) };
  expect(activeAt([open], now)).toBe(open);
  expect(activeAt([{ start: Long.fromNumber(now - 600, true), end: Long.fromNumber(now - 60, true) }], now)).toBeUndefined();
  expect(activeAt([{ start: Long.fromNumber(now + 600, true) }], now)).toBeUndefined();
});

test("alert ids: a reworded alert keeps its id through its feed entities; new alerts get the header-based id", () => {
  const known = new Map<string, string>();
  const [a, b] = resolveAlertIds([{ key: "Limited service between A and B|100", entities: ["u1", "u2"] }, { key: "Works at C|50", entities: ["u3"] }], known);
  expect(a).toBe(Bun.hash("Limited service between A and B|100").toString(36)); // unchanged for alerts already recorded
  expect(b).not.toBe(a);
  // next poll: SBB rewrote the header (English replaced German), one entity group is gone, a new one joined
  const [a2] = resolveAlertIds([{ key: "Eingeschränkter Verkehr zwischen A und B|100", entities: ["u2", "u9"] }], known);
  expect(a2).toBe(a);
  expect(known.get("u9")).toBe(a);
  // two groups claiming the same old id in one poll: only the first keeps it
  const [x, y] = resolveAlertIds([{ key: "k1", entities: ["u3"] }, { key: "k2", entities: ["u3"] }], known);
  expect(x).toBe(b);
  expect(y).toBe(Bun.hash("k2").toString(36));
});
