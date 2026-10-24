// Line identity, shared by the live recorder and the history importer. A line name alone isn't a line: Basel, Bern,
// Luzern and St. Gallen each have an "S1". Trains of one name that share a station are one line, keyed by name plus the
// busiest station they serve ("S1|8500010"), so it stays the same from day to day. Trains without a real line name
// (international EC, ICE, TGV: the name is just the category) become their category, "EC|", and are no line to rank.

/** Key per trip, in order. `uics`: the trip's stations; `pax`: daily passengers per station (0 if unknown). */
export function lineKeys(trips: { name: string; cat: string; uics: string[] }[], pax: (uic: string) => number): string[] {
  const keys: string[] = new Array(trips.length), groups = new Map<string, number[]>();
  trips.forEach((t, i) => {
    if (!t.name || t.name === t.cat) keys[i] = `${t.cat}|`;
    else (groups.get(t.name) ?? groups.set(t.name, []).get(t.name)!).push(i);
  });
  for (const [name, idx] of groups) {
    const parent = idx.map((_, k) => k);
    const find = (k: number) => { while (parent[k] !== k) k = parent[k] = parent[parent[k]]; return k; };
    const at = new Map<string, number>(); // station -> first trip (in this name) calling there
    idx.forEach((i, k) => {
      for (const u of trips[i].uics) {
        const o = at.get(u);
        if (o === undefined) at.set(u, k);
        else parent[find(k)] = find(o);
      }
    });
    const calls = new Map<number, Map<string, number>>(); // component -> station -> calls
    idx.forEach((i, k) => {
      const c = find(k), m = calls.get(c) ?? calls.set(c, new Map()).get(c)!;
      for (const u of trips[i].uics) m.set(u, (m.get(u) ?? 0) + 1);
    });
    const hub = new Map<number, string>();
    for (const [c, m] of calls) {
      // most passengers; without passenger data, most calls; then the lowest UIC, so the choice never flips
      const best = [...m].reduce((a, b) => (pax(b[0]) - pax(a[0]) || b[1] - a[1] || a[0].localeCompare(b[0])) > 0 ? b : a);
      hub.set(c, best[0]);
    }
    idx.forEach((i, k) => (keys[i] = `${name}|${hub.get(find(k))}`));
  }
  return keys;
}

/** "S1|8500010" -> "S1" */
export const lineName = (key: string) => (key.includes("|") ? key.slice(0, key.lastIndexOf("|")) : key);

/** Labels for keys whose name is shared by another line: "S1 · Basel SBB". Unambiguous keys need none (their name); categories ("EC|") and bare names from before keys aren't counted. */
export function ambiguousLabels(keys: Iterable<string>, stationName: (uic: string) => string | undefined) {
  const byName = new Map<string, string[]>();
  for (const k of new Set(keys)) if (/\|[^|]+$/.test(k)) (byName.get(lineName(k)) ?? byName.set(lineName(k), []).get(lineName(k))!).push(k);
  const out: Record<string, string> = {};
  for (const [name, ks] of byName) if (ks.length > 1) for (const k of ks) out[k] = `${name} · ${stationName(k.slice(k.lastIndexOf("|") + 1)) ?? "?"}`;
  return out;
}
