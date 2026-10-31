const TZ = "Europe/Zurich";
const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });

/** "YYYY-MM-DD" in Zurich for an instant. */
export const zurichDate = (d: Date) => fmt.format(d);

export const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Epoch ms that GTFS times of a service day count from: local noon minus 12 h (correct on DST days). */
export function serviceBase(date: string): number {
  const noonUtc = Date.parse(`${date}T12:00:00Z`);
  const local = new Date(noonUtc).toLocaleString("sv-SE", { timeZone: TZ }); // "YYYY-MM-DD HH:MM:SS"
  const offset = Date.parse(local.replace(" ", "T") + "Z") - noonUtc;
  return noonUtc - offset - 12 * 3600_000;
}

/** A "delay" outside this is a broken forecast (e.g. dated a day off: 2019-11-04 averaged −27 h), not a delay: unobserved. */
export const sane = (d: number) => d >= -1800 && d <= 6 * 3600;

/** Swiss timetable year: a new one starts the Sunday after the 2nd Saturday of December. */
export function timetableYear(date: string): number {
  const y = Number(date.slice(0, 4));
  const firstSat = 1 + ((6 - new Date(Date.UTC(y, 11, 1)).getUTCDay() + 7) % 7);
  const change = `${y}-12-${String(firstSat + 8).padStart(2, "0")}`;
  return date >= change ? y + 1 : y;
}
