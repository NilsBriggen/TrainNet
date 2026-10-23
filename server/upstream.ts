// Every call to api.opentransportdata.swiss goes through here: one budget per API from .env
// (<API>_per_Minute, <API>_per_Day; 0 = no daily cap). Calls are logged in stats.db, so a restart doesn't reset the count.
import { db } from "./record";
import { serviceBase, zurichDate } from "./time";

/** No free request slot within the caller's patience; retry after `retryAfter` seconds. */
export class Busy extends Error {
  constructor(api: string, public retryAfter: number) { super(`${api}: busy, free again in ${retryAfter} s`); }
}
/** Today's requests are used up (for this kind of caller). */
export class Budget extends Error {
  constructor(api: string) { super(`${api}: daily limit reached`); }
}

const pausedUntil = new Map<string, number>();
const used = (api: string, since: number) => db.query("SELECT count(*) n, min(t) first FROM upstream_call WHERE api = ? AND t > ?").get(api, since) as { n: number; first: number | null };

/**
 * `background` callers (the formation crawl) leave a fifth of each minute and 15 % of the day to visitors.
 * `maxWait` (ms) is how long a caller may wait for a free slot before getting Busy; polls wait as long as needed.
 */
export async function upstream(api: string, url: string, opts: { background?: boolean; maxWait?: number } = {}): Promise<Response> {
  const token = process.env[`${api}_TOKEN`];
  if (!token) throw new Error(`${api}_TOKEN missing in .env`);
  const perMin = Number(process.env[`${api}_per_Minute`]) || 1;
  const perDay = Number(process.env[`${api}_per_Day`]) || 0;
  const minCap = opts.background ? Math.max(1, Math.floor(perMin * 0.8)) : perMin;
  const dayCap = opts.background ? Math.floor(perDay * 0.85) : perDay;
  const deadline = Date.now() + (opts.maxWait ?? Infinity);

  // check + insert run without an await in between, so concurrent callers can't share a slot
  let today = 0;
  for (;;) {
    const now = Date.now(), minute = used(api, now - 60_000);
    today = used(api, serviceBase(zurichDate(new Date(now)))).n;
    if (perDay && today >= dayCap) throw new Budget(api);
    const wait = now < (pausedUntil.get(api) ?? 0) ? pausedUntil.get(api)! - now : minute.n >= minCap ? 60_000 - (now - minute.first!) + 5 : 0;
    if (!wait) break;
    if (now + wait > deadline) throw new Busy(api, Math.ceil(wait / 1000));
    await Bun.sleep(wait);
  }
  db.query("INSERT INTO upstream_call VALUES (?, ?)").run(api, Date.now());
  console.log(`[upstream] ${api} ${used(api, Date.now() - 60_000).n}/${perMin} last min, ${today + 1} today`);

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000) }); // a hung call must not stall a poll loop
  if (res.status === 429) {
    pausedUntil.set(api, Date.now() + 60_000);
    console.warn(`[upstream] ${api} got 429, pausing 60 s`);
  }
  if (!res.ok) throw new Error(`${api} HTTP ${res.status}`);
  return res;
}
