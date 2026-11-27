import { createHmac, timingSafeEqual } from "node:crypto";

// Protections around the assistant, kept in one place so they are easy to test.
// Each one answers a finding from the security reviews of 27 November 2026.

// ---------------------------------------------------------------------------
// 1. Only Meta may deliver WhatsApp messages.
// Meta signs every webhook delivery with the app secret: the header
// X-Hub-Signature-256 is "sha256=" + an HMAC-SHA256 of the raw body. Without this
// check, anyone could post a fake message "from" any number and act as that guest.

/** True only when the signature matches the raw body and the app secret. */
export function signatureIsValid(rawBody: Buffer | string, header: string | undefined, appSecret: string): boolean {
  // Exactly one well-formed signature: no repeated headers, no stray characters.
  if (!appSecret || !header || !/^sha256=[0-9a-f]{64}$/i.test(header)) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  const given = Buffer.from(header.slice("sha256=".length), "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Compares two secrets without leaking, through timing, how much of the guess was right. */
export function sameSecret(given: string | null | undefined, expected: string): boolean {
  if (!expected || typeof given !== "string") return false;
  const a = createHmac("sha256", "compare").update(given).digest();
  const b = createHmac("sha256", "compare").update(expected).digest();
  return timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// 2. The test chat is only for the laptop it runs on.
// It accepts any typed number, so it must never be reachable from another machine,
// from a tunnel (ngrok, cloudflared) or proxy on this machine, or from a web page
// open in this machine's browser.

/** True for requests from this machine (IPv4 or IPv6 loopback). */
export function isLocalAddress(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

/** True when HOST only listens on this machine. */
export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

/** Headers that tunnels and proxies add. A request carrying any of them came from somewhere else. */
const FORWARDED_HEADERS = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-real-ip", "cf-connecting-ip", "true-client-ip", "x-original-host", "ngrok-skip-browser-warning"];

type RequestLike = {
  method?: string;
  remoteAddress: string | undefined;
  headers: Record<string, string | string[] | undefined>;
};

/** The addresses the test chat page is opened at. */
const localOrigins = (port: number) => [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`];

/**
 * True only for a test chat request typed on this machine:
 * - from the loopback address,
 * - not passed on by a tunnel or proxy (they add forwarding headers, or a different Host),
 * - addressed to localhost by name, which stops DNS rebinding (a web page pointing its own domain at 127.0.0.1),
 * - and, for POSTs, sent as JSON by the test chat page itself, which stops other web pages
 *   open in this browser from sending messages (they can't set this Origin, and can't send JSON
 *   to another site without the browser asking it first).
 */
export function isTestChatRequest(req: RequestLike, port: number): boolean {
  if (!isLocalAddress(req.remoteAddress)) return false;
  if (FORWARDED_HEADERS.some((h) => req.headers[h] !== undefined)) return false;
  const hosts = localOrigins(port);
  if (!hosts.includes(String(req.headers.host ?? "").toLowerCase())) return false;
  if (req.method === "POST") {
    const type = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    if (type !== "application/json") return false;
    const origin = req.headers.origin;
    // Browsers always send Origin on a POST from a page; curl on this laptop may leave it out.
    if (origin !== undefined && !hosts.some((h) => origin === `http://${h}`)) return false;
    const site = req.headers["sec-fetch-site"];
    if (site !== undefined && site !== "same-origin" && site !== "none") return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// 3. One guest can't run up the Claude bill or flood the assistant.

export const MAX_MESSAGE_CHARS = 1500;
export const MESSAGES_PER_HOUR = 30;

/**
 * What to do with a message:
 * - "ok": answer it
 * - "warn": over the limit; tell the guest once
 * - "silent": still over the limit and already told; ignore it
 */
export type LimitDecision = "ok" | "warn" | "silent";

/** Counts each number's messages in a sliding hour. Kept in memory, pruned as it goes. */
export class MessageLimiter {
  private state = new Map<string, { times: number[]; warned: boolean }>();

  constructor(
    private perHour = MESSAGES_PER_HOUR,
    private maxNumbers = 5000,
  ) {}

  /** Records a message and decides what to do with it. */
  check(phone: string, now: number): LimitDecision {
    const hourAgo = now - 60 * 60 * 1000;
    const previous = this.state.get(phone);
    const times = (previous?.times ?? []).filter((t) => t > hourAgo);
    let decision: LimitDecision;
    let warned = previous?.warned ?? false;
    if (times.length >= this.perHour) {
      decision = warned ? "silent" : "warn";
      warned = true;
    } else {
      times.push(now);
      warned = false;
      decision = "ok";
    }
    this.state.delete(phone); // re-insert so the oldest-used numbers are dropped first
    this.state.set(phone, { times, warned });
    while (this.state.size > this.maxNumbers) this.state.delete(this.state.keys().next().value!);
    return decision;
  }

  /** Records a message and says whether it may be answered. */
  allow(phone: string, now: number): boolean {
    return this.check(phone, now) === "ok";
  }
}

/**
 * A ceiling on Claude requests per day for the whole assistant, so many numbers
 * together (or a bug that loops) can't run up an unlimited bill. Resets at
 * midnight Bulawayo time. 0 means no ceiling.
 */
export class DailyBudget {
  private day = "";
  private used = 0;

  constructor(private limit: number) {}

  /** Takes one request from today's budget; false once it is spent. */
  take(now: Date): boolean {
    if (this.limit <= 0) return true;
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Harare" }).format(now);
    if (day !== this.day) {
      this.day = day;
      this.used = 0;
    }
    if (this.used >= this.limit) return false;
    this.used++;
    return true;
  }
}

// ---------------------------------------------------------------------------
// 4. Memory that can't grow forever.

/** Remembers recent ids (e.g. WhatsApp message ids, which Meta may deliver twice), forgetting the oldest. */
export class RecentIds {
  private ids = new Set<string>();

  constructor(private max = 5000) {}

  /** True the first time an id is seen; false if it was seen recently. */
  firstTime(id: string): boolean {
    if (this.ids.has(id)) return false;
    this.ids.add(id);
    if (this.ids.size > this.max) this.ids.delete(this.ids.values().next().value!);
    return true;
  }
}

// ---------------------------------------------------------------------------
// 5. One message at a time per guest.
// Two messages from the same number arriving together would otherwise both read
// and write the same conversation, and could both try to book. A number can only
// have a few messages waiting, so a flood can't pile up work in memory.

export class QueueFull extends Error {}

export class PerPhoneQueue {
  private tails = new Map<string, Promise<unknown>>();
  private waiting = new Map<string, number>();

  constructor(private maxWaiting = 5) {}

  run<T>(phone: string, task: () => Promise<T>): Promise<T> {
    const count = this.waiting.get(phone) ?? 0;
    if (count >= this.maxWaiting) return Promise.reject(new QueueFull());
    this.waiting.set(phone, count + 1);
    const done = () => {
      const left = (this.waiting.get(phone) ?? 1) - 1;
      if (left > 0) this.waiting.set(phone, left);
      else this.waiting.delete(phone);
    };
    const previous = this.tails.get(phone) ?? Promise.resolve();
    const next = previous.then(task, task).finally(done);
    const tail = next.catch(() => undefined);
    this.tails.set(phone, tail);
    tail.then(() => {
      if (this.tails.get(phone) === tail) this.tails.delete(phone);
    });
    return next;
  }
}

// ---------------------------------------------------------------------------
// 6. Request bodies have a size limit.

export const MAX_BODY_BYTES = 1_000_000;

// ---------------------------------------------------------------------------
// 7. Addresses the assistant sends its keys to must be encrypted.

/** True if it's safe to send an API key to this URL: https, or http to this machine for local testing. */
export function isSafeServiceUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}
