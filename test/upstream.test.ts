import { expect, test } from "bun:test";
import { Budget, Busy, upstream } from "../server/upstream";
import { db, initRecord } from "../server/record";
import { serviceBase, timetableYear } from "../server/time";

initRecord(":memory:");

let status = 200;
globalThis.fetch = (async () => new Response("ok", { status })) as any;
Object.assign(process.env, {
  A_TOKEN: "x", A_per_Minute: "2",
  B_TOKEN: "x", B_per_Minute: "2",
  C_TOKEN: "x", C_per_Minute: "5", C_per_Day: "1",
  D_TOKEN: "x", D_per_Minute: "5",
  E_TOKEN: "x", E_per_Minute: "5",
  F_TOKEN: "x", F_per_Minute: "5",
});
const settled = async (p: Promise<unknown>) => {
  let done = false;
  p.then(() => (done = true), () => (done = true));
  await Bun.sleep(30);
  return done;
};

test("call over the per-minute limit waits; other APIs are not blocked", async () => {
  await upstream("A", "u");
  await upstream("A", "u");
  expect(await settled(upstream("A", "u"))).toBe(false);
  expect(await settled(upstream("B", "u"))).toBe(true);
});

test("daily cap rejects", async () => {
  await upstream("C", "u");
  expect(upstream("C", "u")).rejects.toBeInstanceOf(Budget);
});

test("calls made before a restart still count: the log lives in the database", async () => {
  const t = Date.now() - 20_000;
  for (let k = 0; k < 5; k++) db.query("INSERT INTO upstream_call VALUES ('E', ?)").run(t);
  expect(await settled(upstream("E", "u"))).toBe(false);
});

test("visitors get the slots the background crawl leaves free, and hear why when there are none", async () => {
  for (let k = 0; k < 4; k++) await upstream("F", "u", { background: true });
  expect(await settled(upstream("F", "u", { background: true }))).toBe(false); // 4 of 5 is the crawl's share
  await upstream("F", "u", { maxWait: 10 }); // the visitor's slot
  expect(upstream("F", "u", { maxWait: 10 })).rejects.toBeInstanceOf(Busy);
});

test("429 pauses that API", async () => {
  status = 429;
  expect(upstream("D", "u")).rejects.toThrow("429");
  await Bun.sleep(5);
  status = 200;
  expect(await settled(upstream("D", "u"))).toBe(false);
});

test("missing token is an error, not an unauthenticated call", async () => {
  expect(upstream("NOPE", "u")).rejects.toThrow("NOPE_TOKEN");
});

test("service day base and timetable year", () => {
  expect(new Date(serviceBase("2026-10-23")).toISOString()).toBe("2026-10-22T22:00:00.000Z"); // CEST
  expect(new Date(serviceBase("2026-10-25")).toISOString()).toBe("2026-10-24T23:00:00.000Z"); // DST-end day: noon-12h
  expect(timetableYear("2026-12-12")).toBe(2026);
  expect(timetableYear("2026-12-13")).toBe(2027);
});
