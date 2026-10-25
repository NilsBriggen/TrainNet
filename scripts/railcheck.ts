// Read-only report on the routed track paths (data/paths.json, written by the server): legs drawn as straight lines and why,
// and paths that run a large share on sidings, yards or spurs (a platform track mapped as a siding, or a real detour).
//   bun scripts/railcheck.ts [data dir]
const dir = process.argv[2] ?? process.env.DATA_DIR ?? "data";
const cache = await Bun.file(`${dir}/paths.json`).json(), day = await Bun.file(`${dir}/day.json`).json().catch(() => null);
const names = new Map<string, string>((day?.stations ?? []).map((s: any) => [s[3], s[0]]));
const label = (key: string) => key.split("|").map((end) => { const [uic, pl] = end.split(":"); return `${names.get(uic) ?? uic}${pl ? ` (${pl})` : ""}`; }).join(" – ");
// train legs join two timetable stations; the rest are line sections of the Traffic overlay (freight may use yards)
const swiss = new Set<string>((day?.stations ?? []).filter((s: any) => s[3].startsWith("85")).map((s: any) => s[3]));
const isLeg = (k: string) => k.split("|").every((e) => names.has(e.split(":")[0]));
const inCH = (k: string) => k.split("|").some((e) => swiss.has(e.split(":")[0]));
const segs = Object.entries(cache.segs as Record<string, any[] | null>).filter(([k]) => isLeg(k));
const fails = (Object.entries(cache.fails ?? {}) as [string, string][]).filter(([k]) => isLeg(k));
console.log(`${segs.length} train legs, ${segs.filter(([, v]) => v).length} on track, ${fails.length} straight lines (${fails.filter(([k]) => inCH(k)).length} touching Switzerland)`);
const byWhy = new Map<string, string[]>();
for (const [k, why] of fails.filter(([k]) => inCH(k))) (byWhy.get(why.replace(/[\d.]+ km/g, "… km")) ?? byWhy.set(why.replace(/[\d.]+ km/g, "… km"), []).get(why.replace(/[\d.]+ km/g, "… km"))!).push(`${label(k)}${why.includes("km") ? `  [${why}]` : ""}`);
for (const [why, ks] of byWhy) console.log(`\n${ks.length}× ${why}\n  ${ks.slice(0, 40).join("\n  ")}`);
const yards = segs.filter(([, v]) => v && v[3] > 0.1).sort((a, b) => b[1]![3] - a[1]![3]);
console.log(`\n${yards.length} paths with over 10 % on sidings/yards/spurs:\n  ${yards.slice(0, 40).map(([k, v]) => `${Math.round(v![3] * 100)} %  ${label(k)}`).join("\n  ")}`);
