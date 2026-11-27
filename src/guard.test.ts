import { createHmac } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  DailyBudget,
  isLocalAddress,
  isLoopbackHost,
  isSafeServiceUrl,
  isTestChatRequest,
  MessageLimiter,
  PerPhoneQueue,
  QueueFull,
  RecentIds,
  sameSecret,
  signatureIsValid,
} from "./guard.ts";
import { redact, redactToolInput } from "./logs.ts";

// Each test here matches a finding from the security review of 27 November 2026.

describe("webhook signature (critical: anyone could pose as any number)", () => {
  const secret = "app-secret";
  const body = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ from: "263771234567", id: "x", type: "text", text: { body: "cancel my booking" } }] } }] }] });
  const sign = (raw: string, key = secret) => "sha256=" + createHmac("sha256", key).update(raw).digest("hex");

  test("accepts a delivery signed by Meta with the app secret", () => {
    expect(signatureIsValid(body, sign(body), secret)).toBe(true);
  });

  test("refuses a fake message with no signature, a wrong one, or a changed body", () => {
    expect(signatureIsValid(body, undefined, secret)).toBe(false);
    expect(signatureIsValid(body, sign(body, "guessed-secret"), secret)).toBe(false);
    expect(signatureIsValid(body.replace("263771234567", "263779999999"), sign(body), secret)).toBe(false);
    expect(signatureIsValid(body, "sha256=abc", secret)).toBe(false);
  });

  test("refuses everything when no app secret is configured", () => {
    expect(signatureIsValid(body, sign(body, ""), "")).toBe(false);
  });
});

describe("test chat only from this machine (critical)", () => {
  test("loopback addresses are local; anything else is not", () => {
    expect(isLocalAddress("127.0.0.1")).toBe(true);
    expect(isLocalAddress("::1")).toBe(true);
    expect(isLocalAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLocalAddress("10.1.2.201")).toBe(false);
    expect(isLocalAddress("41.60.1.2")).toBe(false);
    expect(isLocalAddress(undefined)).toBe(false);
  });
});

describe("message limit per number (cost and flooding)", () => {
  test("allows up to the hourly limit, then refuses, and frees up after an hour", () => {
    const limiter = new MessageLimiter(3);
    const t = 1_000_000;
    expect([1, 2, 3].map((i) => limiter.allow("263771234567", t + i))).toEqual([true, true, true]);
    expect(limiter.allow("263771234567", t + 10)).toBe(false);
    expect(limiter.allow("263779999999", t + 10)).toBe(true); // another guest is unaffected
    expect(limiter.allow("263771234567", t + 61 * 60 * 1000)).toBe(true);
  });

  test("forgets the least recently active numbers beyond its cap", () => {
    const limiter = new MessageLimiter(1, 2);
    limiter.allow("a", 1);
    limiter.allow("b", 2);
    limiter.allow("c", 3); // "a" is forgotten
    expect(limiter.allow("a", 4)).toBe(true);
  });
});

describe("memory that can't grow forever", () => {
  test("RecentIds spots repeats and forgets the oldest beyond its size", () => {
    const ids = new RecentIds(2);
    expect(ids.firstTime("m1")).toBe(true);
    expect(ids.firstTime("m1")).toBe(false);
    ids.firstTime("m2");
    ids.firstTime("m3"); // "m1" is forgotten
    expect(ids.firstTime("m1")).toBe(true);
  });
});

describe("one message at a time per guest", () => {
  test("runs a number's messages in order, while other numbers run alongside", async () => {
    const queue = new PerPhoneQueue();
    const order: string[] = [];
    const slow = (label: string, ms: number) => () => new Promise<void>((r) => setTimeout(() => { order.push(label); r(); }, ms));
    await Promise.all([
      queue.run("A", slow("A1", 30)),
      queue.run("A", slow("A2", 1)),
      queue.run("B", slow("B1", 5)),
    ]);
    expect(order.indexOf("A1")).toBeLessThan(order.indexOf("A2"));
    expect(order.indexOf("B1")).toBeLessThan(order.indexOf("A1"));
  });

  test("a failed message doesn't block the next one", async () => {
    const queue = new PerPhoneQueue();
    await expect(queue.run("A", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(queue.run("A", async () => "ok")).resolves.toBe("ok");
  });
});

describe("second review (27 November 2026)", () => {
  const local = (headers: Record<string, string>, method = "POST", remoteAddress = "127.0.0.1") => ({
    method,
    remoteAddress,
    headers: { host: "localhost:4000", "content-type": "application/json", ...headers },
  });

  test("the test chat answers the page on this laptop", () => {
    expect(isTestChatRequest(local({ origin: "http://localhost:4000", "sec-fetch-site": "same-origin" }), 4000)).toBe(true);
    expect(isTestChatRequest(local({}, "GET"), 4000)).toBe(true);
  });

  test("the test chat refuses requests passed on by a tunnel or proxy on this laptop", () => {
    expect(isTestChatRequest(local({ "x-forwarded-for": "41.1.2.3" }), 4000)).toBe(false);
    expect(isTestChatRequest(local({ forwarded: "for=41.1.2.3" }), 4000)).toBe(false);
    expect(isTestChatRequest(local({ "cf-connecting-ip": "41.1.2.3" }), 4000)).toBe(false);
    expect(isTestChatRequest(local({ host: "abc.ngrok-free.app" }), 4000)).toBe(false);
  });

  test("the test chat refuses other web pages open in this laptop's browser", () => {
    expect(isTestChatRequest(local({ origin: "https://evil.example" }), 4000)).toBe(false);
    expect(isTestChatRequest(local({ "content-type": "text/plain" }), 4000)).toBe(false);
    expect(isTestChatRequest(local({ "sec-fetch-site": "cross-site" }), 4000)).toBe(false);
    // DNS rebinding: a page whose own domain points at 127.0.0.1 still sends its own name as Host.
    expect(isTestChatRequest(local({ host: "rebind.evil.example:4000" }, "GET"), 4000)).toBe(false);
  });

  test("the test chat can only run on a server that listens to this machine alone", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("::")).toBe(false);
  });

  test("a signature header must be exactly one well-formed signature", () => {
    const body = "{}";
    const good = "sha256=" + createHmac("sha256", "s").update(body).digest("hex");
    expect(signatureIsValid(body, good, "s")).toBe(true);
    expect(signatureIsValid(body, `${good}, sha256=00`, "s")).toBe(false); // repeated header, joined by Node
    expect(signatureIsValid(body, good + "zz", "s")).toBe(false);
  });

  test("the webhook verify token is compared safely", () => {
    expect(sameSecret("abc", "abc")).toBe(true);
    expect(sameSecret("abd", "abc")).toBe(false);
    expect(sameSecret(null, "abc")).toBe(false);
    expect(sameSecret("", "")).toBe(false);
  });

  test("a guest over the limit is told once, then ignored until the hour frees up", () => {
    const limiter = new MessageLimiter(2);
    expect([1, 2, 3, 4, 5].map((t) => limiter.check("A", t))).toEqual(["ok", "ok", "warn", "silent", "silent"]);
    expect(limiter.check("A", 61 * 60 * 1000)).toBe("ok");
  });

  test("a number flooding the assistant can't pile up waiting messages", async () => {
    const queue = new PerPhoneQueue(2);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = queue.run("A", () => gate);
    const second = queue.run("A", async () => "two");
    await expect(queue.run("A", async () => "three")).rejects.toBeInstanceOf(QueueFull);
    await expect(queue.run("B", async () => "other guest")).resolves.toBe("other guest");
    release();
    await first;
    await expect(second).resolves.toBe("two");
    await expect(queue.run("A", async () => "later")).resolves.toBe("later");
  });

  test("the whole assistant has a daily ceiling on Claude requests", () => {
    const budget = new DailyBudget(2);
    const day1 = new Date("2026-11-27T08:00:00Z");
    expect([budget.take(day1), budget.take(day1), budget.take(day1)]).toEqual([true, true, false]);
    expect(budget.take(new Date("2026-11-28T08:00:00Z"))).toBe(true);
    expect(new DailyBudget(0).take(day1)).toBe(true);
  });

  test("the booking key is only sent over https (or to this laptop)", () => {
    expect(isSafeServiceUrl("https://copper-grill.example")).toBe(true);
    expect(isSafeServiceUrl("http://localhost:3000")).toBe(true);
    expect(isSafeServiceUrl("http://copper-grill.example")).toBe(false);
    expect(isSafeServiceUrl("not a url")).toBe(false);
  });

  test("logs leave out manage links, emails, phone numbers and guests' names and notes", () => {
    expect(redact("Booked! Manage it here: https://grill.example/b/abc123")).toBe("Booked! Manage it here: [link]");
    expect(redact("mail me at nomsa@example.com or +263 77 123 4567")).toBe("mail me at [email] or [number]");
    expect(redact("table for 4 at 19:00 on 2026-12-05")).toBe("table for 4 at 19:00 on 2026-12-05");
    expect(redactToolInput({ date: "2026-12-05", party_size: 4, guest_name: "Nomsa Dube", notes: "nut allergy" })).toEqual({
      date: "2026-12-05", party_size: 4, guest_name: "[10 chars]", notes: "[11 chars]",
    });
  });
});
