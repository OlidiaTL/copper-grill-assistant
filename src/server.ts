import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import Anthropic from "@anthropic-ai/sdk";
import { type AgentDeps, Conversations, reply } from "./agent.ts";
import { grillClient } from "./grill.ts";
import {
  DailyBudget,
  isLoopbackHost,
  isSafeServiceUrl,
  isTestChatRequest,
  MAX_BODY_BYTES,
  MAX_MESSAGE_CHARS,
  MessageLimiter,
  PerPhoneQueue,
  QueueFull,
  RecentIds,
  sameSecret,
  signatureIsValid,
} from "./guard.ts";
import { redactToolInput, shortPhone, TurnLog } from "./logs.ts";
import { incomingMessages, sendText, toInternational, type Incoming, type WhatsAppConfig } from "./whatsapp.ts";

// The assistant's web server:
//   GET  /         a test chat page that works like WhatsApp (only with TEST_CHAT=1, only typed on this laptop)
//   POST /chat     the test page sends messages here (same rules)
//   GET  /webhook  Meta checks the webhook once when you connect it
//   POST /webhook  WhatsApp delivers guests' messages here (only if Meta's signature is valid)

const env = (name: string, fallback = "") => process.env[name]?.trim() || fallback;
const fail = (message: string) => {
  console.error(message);
  process.exit(1);
};

const missing = ["ANTHROPIC_API_KEY", "GRILL_API_KEY"].filter((n) => !env(n));
if (missing.length) fail(`Missing ${missing.join(", ")} in .env (copy .env.example to .env and fill it in).`);

const grillUrl = env("GRILL_URL", "http://localhost:3000");
if (!isSafeServiceUrl(grillUrl)) fail(`GRILL_URL must start with https:// (http:// is only allowed for localhost), so the booking key is never sent unencrypted.`);

const port = Number(env("PORT", "4000"));
// Only this machine can connect unless HOST is set (e.g. HOST=0.0.0.0 on a server that receives WhatsApp webhooks).
const host = env("HOST", "127.0.0.1");

// The test chat takes any typed number, so it is off unless asked for, and then only answers this machine.
const testChat = env("TEST_CHAT") === "1";
if (testChat && !isLoopbackHost(host)) {
  fail(`TEST_CHAT=1 only works with HOST=127.0.0.1. The test chat lets anyone pose as any guest, so it must never run on a server that others can reach (HOST=${host}).`);
}
const appSecret = env("WHATSAPP_APP_SECRET");

const budget = new DailyBudget(Number(env("CLAUDE_DAILY_CALL_LIMIT", "3000")) || 0);
const deps: AgentDeps = {
  // A stuck request gives up after 30 seconds, so one slow answer can't hold up a guest's later messages for long.
  model: new Anthropic({ timeout: 30_000, maxRetries: 1 }).messages,
  modelName: env("CLAUDE_MODEL", "claude-sonnet-5-5"),
  grill: grillClient(grillUrl, env("GRILL_API_KEY")),
  budget: (now) => budget.take(now),
  privacyUrl: env("PRIVACY_URL"),
  onTool: (e) => console.log(`  tool ${e.name}${e.isError ? " (error)" : ""}`, JSON.stringify(redactToolInput(e.input))),
};
const conversations = new Conversations();
const limiter = new MessageLimiter();
const queue = new PerPhoneQueue();
const seen = new RecentIds();
const turnLog = new TurnLog("logs", Number(env("LOG_KEEP_DAYS", "30")));

const TOO_MANY = "You've sent a lot of messages in the last hour. Please try again a little later, or call the restaurant.";
const TOO_LONG = `That message is too long for me. Could you send it in a shorter message (under ${MAX_MESSAGE_CHARS} characters)?`;
const TEXT_ONLY = "Sorry, I can only read text messages for now. Could you type what you'd like?";
/** WhatsApp only lets a business reply freely within 24 hours of a guest's message; older deliveries are stale or replayed. */
const MAX_MESSAGE_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Answers one guest message, one at a time per number, within that number's hourly limit.
 * Null means "send nothing": the guest has already been told they're over the limit, or is flooding.
 */
async function answer(phone: string, text: string | null): Promise<string | null> {
  try {
    return await queue.run(phone, async () => {
      const decision = limiter.check(phone, Date.now());
      if (decision === "silent") return null;
      if (decision === "warn") return TOO_MANY;
      if (text === null) return TEXT_ONLY;
      if (text.length > MAX_MESSAGE_CHARS) return TOO_LONG;
      return reply(deps, conversations, phone, text);
    });
  } catch (error) {
    if (error instanceof QueueFull) return null;
    throw error;
  }
}

const whatsapp: WhatsAppConfig | null =
  env("WHATSAPP_TOKEN") && env("WHATSAPP_PHONE_NUMBER_ID")
    ? { token: env("WHATSAPP_TOKEN"), phoneNumberId: env("WHATSAPP_PHONE_NUMBER_ID"), graphVersion: env("WHATSAPP_GRAPH_VERSION", "v23.0") }
    : null;

/** Writes to the accuracy log, without letting a full disk or similar stop the guest's reply. */
async function logTurn(channel: string, phone: string, guest: string, words: string) {
  try {
    await turnLog.write(channel, phone, guest, words);
  } catch (error) {
    console.error("Couldn't write the accuracy log:", error instanceof Error ? error.message : error);
  }
}

/** Handles one WhatsApp message on its own, so a problem with one guest never loses another guest's message. */
async function handleWhatsApp(config: WhatsAppConfig, message: Incoming) {
  try {
    if (Date.now() - message.sentAt > MAX_MESSAGE_AGE_MS) {
      console.warn(`[whatsapp ${shortPhone(message.from)}] skipped: sent more than 24 hours ago`);
      return;
    }
    console.log(`[whatsapp ${shortPhone(message.from)}] ${message.text === null ? "(not text)" : `message, ${message.text.length} chars`}`);
    const words = await answer(message.from, message.text);
    if (words === null) return;
    // One retry: a reply that fails to send is otherwise lost, because Meta won't deliver the message again.
    const sent = (await sendText(config, message.from, words).catch(() => false)) || (await sendText(config, message.from, words).catch(() => false));
    if (!sent) console.error(`[whatsapp ${shortPhone(message.from)}] reply could not be sent`);
    await logTurn("whatsapp", message.from, message.text ?? "(not text)", words);
  } catch (error) {
    console.error(`[whatsapp ${shortPhone(message.from)}] failed:`, error instanceof Error ? error.message : error);
  }
}

class TooLarge extends Error {}

/** Reads the raw request body, refusing anything over MAX_BODY_BYTES. */
async function readBody(req: IncomingMessage): Promise<Buffer> {
  const declared = Number(req.headers["content-length"]);
  if (declared > MAX_BODY_BYTES) throw new TooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new TooLarge();
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

const send = (res: ServerResponse, status: number, body: string, type = "application/json") => {
  res.writeHead(status, { "Content-Type": type, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" });
  res.end(body);
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    const isTestChatRoute = (req.method === "GET" && url.pathname === "/") || (req.method === "POST" && url.pathname === "/chat");
    if (isTestChatRoute && !(testChat && isTestChatRequest({ method: req.method, remoteAddress: req.socket.remoteAddress, headers: req.headers }, port))) {
      return send(res, 404, JSON.stringify({ error: "not_found" }));
    }

    if (req.method === "GET" && url.pathname === "/") {
      res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'");
      return send(res, 200, await readFile(new URL("../public/chat.html", import.meta.url), "utf8"), "text/html; charset=utf-8");
    }

    if (req.method === "POST" && url.pathname === "/chat") {
      const body: unknown = JSON.parse((await readBody(req)).toString("utf8"));
      if (typeof body !== "object" || body === null || Array.isArray(body)) return send(res, 400, JSON.stringify({ error: "body" }));
      const { phone: typed, text, reset } = body as Record<string, unknown>;
      if (typeof typed !== "string" || (text !== undefined && typeof text !== "string") || (reset !== undefined && typeof reset !== "boolean")) {
        return send(res, 400, JSON.stringify({ error: "types" }));
      }
      // Real WhatsApp reports the sender in full international digits (263771234567),
      // the only form the booking API accepts, so the test chat converts to the same.
      const phone = toInternational(typed);
      if (!phone) return send(res, 400, JSON.stringify({ error: "phone", message: "Use +country code (e.g. +27 82 123 4567) or a Zimbabwe mobile (077...)." }));
      if (reset) {
        await queue.run(phone, async () => conversations.clear(phone)).catch(() => undefined);
        return send(res, 200, JSON.stringify({ reply: "" }));
      }
      if (!text?.trim()) return send(res, 400, JSON.stringify({ error: "text" }));
      console.log(`[chat ${phone}] ${text}`);
      const words = await answer(phone, text);
      if (words !== null) await logTurn("test-chat", phone, text, words);
      return send(res, 200, JSON.stringify({ reply: words ?? "(no reply: over the message limit)" }));
    }

    if (req.method === "GET" && url.pathname === "/webhook") {
      const ok = url.searchParams.get("hub.mode") === "subscribe" && sameSecret(url.searchParams.get("hub.verify_token"), env("WHATSAPP_VERIFY_TOKEN"));
      const challenge = url.searchParams.get("hub.challenge") ?? "";
      // Meta's challenge is a number; echo nothing else.
      return ok && /^\d{1,64}$/.test(challenge) ? send(res, 200, challenge, "text/plain") : send(res, 403, "Forbidden", "text/plain");
    }

    if (req.method === "POST" && url.pathname === "/webhook") {
      // Closed unless WhatsApp is fully set up, including the app secret that proves a message came from Meta.
      if (!whatsapp || !appSecret) {
        console.warn("WhatsApp delivery refused: WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_APP_SECRET must all be set.");
        return send(res, 503, JSON.stringify({ error: "not_configured" }));
      }
      const raw = await readBody(req);
      const signature = req.headers["x-hub-signature-256"];
      if (!signatureIsValid(raw, typeof signature === "string" ? signature : undefined, appSecret)) {
        console.warn("WhatsApp delivery refused: signature missing or wrong.");
        return send(res, 401, JSON.stringify({ error: "bad_signature" }));
      }
      const payload: unknown = JSON.parse(raw.toString("utf8"));
      // Answer Meta straight away; reply to the guests after, each on their own.
      send(res, 200, "{}");
      const fresh = incomingMessages(payload, whatsapp.phoneNumberId).filter((m) => seen.firstTime(m.id)); // Meta can deliver the same message twice.
      await Promise.allSettled(fresh.map((m) => handleWhatsApp(whatsapp, m)));
      return;
    }

    send(res, 404, JSON.stringify({ error: "not_found" }));
  } catch (error) {
    if (res.headersSent) return console.error(error);
    if (error instanceof TooLarge) return send(res, 413, JSON.stringify({ error: "too_large" }));
    if (error instanceof SyntaxError) return send(res, 400, JSON.stringify({ error: "bad_json" }));
    console.error(error);
    send(res, 500, JSON.stringify({ reply: "Sorry, something went wrong on my side. Please try again." }));
  }
});

server.listen(port, host, () => {
  console.log(`Copper Grill assistant running on ${host}:${port}.`);
  console.log(testChat ? `Test chat: http://localhost:${port}` : "Test chat is off (set TEST_CHAT=1 in .env to use it on this laptop).");
  console.log(
    `Model ${deps.modelName}; booking system ${grillUrl}; ` +
      `WhatsApp ${whatsapp && appSecret ? "connected" : whatsapp ? "NOT accepting messages: WHATSAPP_APP_SECRET is missing" : "not set up yet"}.`,
  );
});
