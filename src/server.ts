import { appendFile, mkdir, readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import Anthropic from "@anthropic-ai/sdk";
import { type AgentDeps, Conversations, reply } from "./agent.ts";
import { grillClient } from "./grill.ts";
import { incomingMessages, sendText, toWhatsAppNumber, type WhatsAppConfig } from "./whatsapp.ts";

// The assistant's web server:
//   GET  /         a test chat page that works like WhatsApp, for trying it on your laptop
//   POST /chat     the test page sends messages here
//   GET  /webhook  Meta checks the webhook once when you connect it
//   POST /webhook  WhatsApp delivers guests' messages here

const env = (name: string, fallback = "") => process.env[name]?.trim() || fallback;

const missing = ["ANTHROPIC_API_KEY", "GRILL_API_KEY"].filter((n) => !env(n));
if (missing.length) {
  console.error(`Missing ${missing.join(", ")} in .env (copy .env.example to .env and fill it in).`);
  process.exit(1);
}

const deps: AgentDeps = {
  model: new Anthropic().messages,
  modelName: env("CLAUDE_MODEL", "claude-sonnet-5-5"),
  grill: grillClient(env("GRILL_URL", "http://localhost:3000"), env("GRILL_API_KEY")),
  onTool: (e) => console.log(`  tool ${e.name}${e.isError ? " (error)" : ""}`, JSON.stringify(e.input)),
};
const conversations = new Conversations();

const whatsapp: WhatsAppConfig | null =
  env("WHATSAPP_TOKEN") && env("WHATSAPP_PHONE_NUMBER_ID")
    ? { token: env("WHATSAPP_TOKEN"), phoneNumberId: env("WHATSAPP_PHONE_NUMBER_ID"), graphVersion: env("WHATSAPP_GRAPH_VERSION", "v23.0") }
    : null;

/** Every exchange goes into logs/turns.jsonl: the raw material for the accuracy log. */
async function logTurn(channel: string, phone: string, guest: string, answer: string) {
  await mkdir("logs", { recursive: true });
  const line = { at: new Date().toISOString(), channel, phone: "…" + phone.slice(-4), guest, answer };
  await appendFile("logs/turns.jsonl", JSON.stringify(line) + "\n");
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const send = (res: ServerResponse, status: number, body: string, type = "application/json") => {
  res.writeHead(status, { "Content-Type": type });
  res.end(body);
};

const seen = new Set<string>();

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    if (req.method === "GET" && url.pathname === "/") {
      return send(res, 200, await readFile(new URL("../public/chat.html", import.meta.url), "utf8"), "text/html; charset=utf-8");
    }

    if (req.method === "POST" && url.pathname === "/chat") {
      const body = JSON.parse(await readBody(req)) as { phone?: string; text?: string; reset?: boolean };
      const { text, reset } = body;
      // Real WhatsApp reports the sender in full international digits (263771234567),
      // the only form the booking API accepts, so the test chat converts to the same.
      const phone = toWhatsAppNumber(body.phone ?? "");
      if (!phone) return send(res, 400, JSON.stringify({ error: "phone" }));
      if (reset) {
        conversations.clear(phone);
        return send(res, 200, JSON.stringify({ reply: "" }));
      }
      if (!text?.trim()) return send(res, 400, JSON.stringify({ error: "text" }));
      console.log(`[chat ${phone}] ${text}`);
      const answer = await reply(deps, conversations, phone, text);
      await logTurn("test-chat", phone, text, answer);
      return send(res, 200, JSON.stringify({ reply: answer }));
    }

    if (req.method === "GET" && url.pathname === "/webhook") {
      const ok = url.searchParams.get("hub.mode") === "subscribe" && url.searchParams.get("hub.verify_token") === env("WHATSAPP_VERIFY_TOKEN") && env("WHATSAPP_VERIFY_TOKEN");
      return ok ? send(res, 200, url.searchParams.get("hub.challenge") ?? "", "text/plain") : send(res, 403, "Forbidden", "text/plain");
    }

    if (req.method === "POST" && url.pathname === "/webhook") {
      const payload = JSON.parse(await readBody(req));
      // Answer Meta straight away; reply to the guest after.
      send(res, 200, "{}");
      if (!whatsapp) return console.warn("WhatsApp message received but WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID are not set.");
      for (const message of incomingMessages(payload)) {
        if (seen.has(message.id)) continue; // Meta can deliver the same message twice.
        seen.add(message.id);
        console.log(`[whatsapp ${message.from}] ${message.text}`);
        const answer = await reply(deps, conversations, message.from, message.text);
        await sendText(whatsapp, message.from, answer);
        await logTurn("whatsapp", message.from, message.text, answer);
      }
      return;
    }

    send(res, 404, JSON.stringify({ error: "not_found" }));
  } catch (error) {
    console.error(error);
    if (!res.headersSent) send(res, 500, JSON.stringify({ reply: "Sorry, something went wrong on my side. Please try again." }));
  }
});

const port = Number(env("PORT", "4000"));
server.listen(port, () => {
  console.log(`Copper Grill assistant running. Test chat: http://localhost:${port}`);
  console.log(`Model ${deps.modelName}; booking system ${env("GRILL_URL", "http://localhost:3000")}; WhatsApp ${whatsapp ? "connected" : "not set up yet"}.`);
});
