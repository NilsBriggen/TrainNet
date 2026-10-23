import { expect, test } from "bun:test";
import { upstream } from "../server/upstream";
import { serviceBase, timetableYear } from "../server/time";

let status = 200;
globalThis.fetch = (async () => new Response("ok", { status })) as any;
Object.assign(process.env, {
  A_TOKEN: "x", A_per_Minute: "2",
  B_TOKEN: "x", B_per_Minute: "2",
  C_TOKEN: "x", C_per_Minute: "5", C_per_Day: "1",
  D_TOKEN: "x", D_per_Minute: "5",
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
  expect(upstream("C", "u")).rejects.toThrow("daily limit");
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
