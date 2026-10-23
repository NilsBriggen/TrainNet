// Every call to api.opentransportdata.swiss goes through here: one limiter per API,
// limits read from .env (<API>_per_Minute, <API>_per_Day; 0 = no daily cap).
import { zurichDate } from "./time";

type State = { times: number[]; day: string; count: number; pausedUntil: number };
const states = new Map<string, State>();

export async function upstream(api: string, url: string): Promise<Response> {
  const token = process.env[`${api}_TOKEN`];
  if (!token) throw new Error(`${api}_TOKEN missing in .env`);
  const perMin = Number(process.env[`${api}_per_Minute`]) || 1;
  const perDay = Number(process.env[`${api}_per_Day`]) || 0;
  let s = states.get(api);
  if (!s) states.set(api, (s = { times: [], day: "", count: 0, pausedUntil: 0 }));

  // check + push below run without an await in between, so concurrent callers can't share a slot
  for (;;) {
    const now = Date.now();
    s.times = s.times.filter((t) => now - t < 60_000);
    if (now < s.pausedUntil) await Bun.sleep(s.pausedUntil - now);
    else if (s.times.length >= perMin) await Bun.sleep(60_000 - (now - s.times[0]) + 5);
    else break;
  }
  const today = zurichDate(new Date());
  if (s.day !== today) Object.assign(s, { day: today, count: 0 });
  if (perDay && s.count >= perDay) throw new Error(`${api}: daily limit ${perDay} reached`);
  s.times.push(Date.now());
  s.count++;
  console.log(`[upstream] ${api} ${s.times.length}/${perMin} last min, ${s.count} today`);

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 429) {
    s.pausedUntil = Date.now() + 60_000;
    console.warn(`[upstream] ${api} got 429, pausing 60 s`);
  }
  if (!res.ok) throw new Error(`${api} HTTP ${res.status}`);
  return res;
}
