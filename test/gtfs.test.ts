import { expect, test } from "bun:test";
import { serviceDays } from "../server/gtfs";

// calendar.txt: service_id, mon … sun, start_date, end_date
const cal = (id: string, week: string, start = "20251214", end = "20261212") => [id, ...week.split(""), start, end];

test("weekly calendar picks the right weekday, within its date range", () => {
  // 2026-10-24 is a Saturday, 2026-10-23 the Friday before (trains still running past midnight)
  const { running, calendar } = serviceDays(["2026-10-24", "2026-10-23"]);
  calendar(cal("WEEKEND", "0000011"));
  calendar(cal("WEEKDAYS", "1111100"));
  calendar(cal("EXPIRED", "1111111", "20251214", "20261001"));
  expect([...running[0]]).toEqual(["WEEKEND"]);
  expect([...running[1]]).toEqual(["WEEKDAYS"]);
});

test("date exceptions add and remove services on top of the calendar", () => {
  const { running, calendar, exception } = serviceDays(["2026-10-24", "2026-10-23"]);
  calendar(cal("WEEKEND", "0000011"));
  exception(["WEEKEND", "20261024", "2"]); // removed this Saturday
  exception(["EXTRA", "20261024", "1"]); // added this Saturday
  exception(["EXTRA", "20261030", "1"]); // another day: ignored
  expect([...running[0]]).toEqual(["EXTRA"]);
  expect([...running[1]]).toEqual([]);
});
