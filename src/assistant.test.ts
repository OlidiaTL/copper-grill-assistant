import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, test } from "vitest";
import { Conversations, reply, trim } from "./agent.ts";
import type { Booking, Grill, GrillReply } from "./grill.ts";
import { systemPrompt } from "./prompt.ts";
import { runTool } from "./tools.ts";
import { incomingMessages, toWhatsAppNumber } from "./whatsapp.ts";

// These tests use a scripted stand-in for Claude and a fake booking system, so
// they run without an API key or a database. They check the plumbing and the
// safety rules; how well Claude talks is checked with the test chat page.

const booking = (token: string): Booking => ({
  token, date: "2026-11-28", time: "19:00", until: "21:00", partySize: 4, table: "M7",
  area: "Main room", status: "confirmed", guestName: "Nomsa", manageUrl: `http://x/booking/${token}`,
});

function fakeGrill(owned: Record<string, string[]> = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const ok = <T,>(body: T): GrillReply<T> => ({ ok: true, status: 200, body });
  const grill: Grill = {
    info: async () => (calls.push({ method: "info", args: [] }), ok({ name: "The Copper Grill", phone: null })),
    availability: async (...args) => (calls.push({ method: "availability", args }), ok({ ok: true, times: ["18:30", "19:00"] })),
    book: async (...args) => (calls.push({ method: "book", args }), ok({ ok: true, booking: booking("new") })),
    bookingsFor: async (phone) => (calls.push({ method: "bookingsFor", args: [phone] }), ok({ bookings: (owned[phone] ?? []).map(booking) })),
    cancel: async (...args) => (calls.push({ method: "cancel", args }), ok({ ok: true })),
    enquiry: async (...args) => (calls.push({ method: "enquiry", args }), ok({ ok: true, id: "e1" })),
    reminders: async () => ok({ reminders: [] }),
  };
  return { grill, calls };
}

/** A pretend Claude that replies with the given turns in order. */
function scriptedModel(turns: Anthropic.ContentBlock[][]) {
  const requests: Anthropic.MessageCreateParams[] = [];
  let i = 0;
  const create = async (params: Anthropic.MessageCreateParams) => {
    // Copy, because the agent keeps adding to the same array afterwards.
    requests.push({ ...params, messages: [...params.messages] });
    const content = turns[i++] ?? [];
    return {
      content,
      stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
    } as unknown as Anthropic.Message;
  };
  return { model: { create } as unknown as Pick<Anthropic["messages"], "create">, requests };
}

const say = (text: string) => ({ type: "text", text, citations: null }) as Anthropic.TextBlock;
const use = (id: string, name: string, input: unknown) =>
  ({ type: "tool_use", id, name, input, caller: { type: "direct" } }) as Anthropic.ToolUseBlock;

describe("reply", () => {
  test("runs tools, feeds results back, and returns Claude's words", async () => {
    const { grill, calls } = fakeGrill();
    const { model, requests } = scriptedModel([
      [use("t1", "check_availability", { date: "2026-11-28", party_size: 4 })],
      [say("We have 18:30 or 19:00 on Saturday. Which would you like?")],
    ]);
    const answer = await reply({ model, modelName: "m", grill }, new Conversations(), "0771234567", "Table for 4 Saturday?");

    expect(answer).toBe("We have 18:30 or 19:00 on Saturday. Which would you like?");
    expect(calls).toEqual([{ method: "availability", args: ["2026-11-28", 4] }]);
    const second = requests[1].messages.at(-1)!;
    expect(second.role).toBe("user");
    expect(JSON.stringify(second.content)).toContain("19:00");
  });

  test("remembers the conversation for the same phone, and keeps guests apart", async () => {
    const { grill } = fakeGrill();
    const { model, requests } = scriptedModel([[say("Hi!")], [say("Sure.")], [say("Hello!")]]);
    const conversations = new Conversations();
    await reply({ model, modelName: "m", grill }, conversations, "0771111111", "Hello");
    await reply({ model, modelName: "m", grill }, conversations, "0771111111", "Book a table");
    await reply({ model, modelName: "m", grill }, conversations, "0772222222", "Hi");

    expect(requests[1].messages).toHaveLength(3); // hello, hi!, book a table
    expect(requests[2].messages).toHaveLength(1); // a different guest starts fresh
  });

  test("gives up politely if Claude keeps calling tools without answering", async () => {
    const { grill } = fakeGrill();
    const loop = Array.from({ length: 20 }, (_, i) => [use(`t${i}`, "get_restaurant_info", {})]);
    const { model } = scriptedModel(loop);
    const answer = await reply({ model, modelName: "m", grill }, new Conversations(), "077", "?");
    expect(answer).toMatch(/team member/);
  });

  test("tells Claude when the booking system can't be reached, instead of crashing", async () => {
    const { grill } = fakeGrill();
    grill.availability = async () => { throw new Error("offline"); };
    const { model, requests } = scriptedModel([
      [use("t1", "check_availability", { date: "2026-11-28", party_size: 2 })],
      [say("Sorry, I can't check right now.")],
    ]);
    await reply({ model, modelName: "m", grill }, new Conversations(), "077", "Table?");
    expect(JSON.stringify(requests[1].messages.at(-1)!.content)).toContain("unreachable");
  });
});

describe("runTool safety", () => {
  test("books with the number the guest is messaging from, whatever the model says", async () => {
    const { grill, calls } = fakeGrill();
    await runTool(grill, "0771234567", "create_booking", {
      date: "2026-11-28", time: "19:00", party_size: 4, guest_name: "Nomsa", whatsapp_consent: true, guestPhone: "0789999999",
    });
    expect(calls[0].args[0]).toMatchObject({ guestPhone: "0771234567", whatsappConsent: true });
  });

  test("consent is only recorded when the model passes an explicit true", async () => {
    const { grill, calls } = fakeGrill();
    await runTool(grill, "077", "create_booking", { date: "d", time: "t", party_size: 2, guest_name: "N", whatsapp_consent: "yes" });
    expect(calls[0].args[0]).toMatchObject({ whatsappConsent: false });
  });

  test("a guest can cancel only their own booking", async () => {
    const { grill, calls } = fakeGrill({ "0771111111": ["mine"] });
    const theirs = await runTool(grill, "0771111111", "cancel_booking", { token: "someone-elses" });
    expect(theirs.isError).toBe(true);
    expect(calls.some((c) => c.method === "cancel")).toBe(false);

    const mine = await runTool(grill, "0771111111", "cancel_booking", { token: "mine" });
    expect(mine.isError).toBe(false);
    expect(calls.filter((c) => c.method === "cancel")).toEqual([{ method: "cancel", args: ["mine"] }]);
  });
});

describe("trim", () => {
  test("never starts the kept history with a tool result", () => {
    const messages: Anthropic.MessageParam[] = [];
    for (let i = 0; i < 20; i++) {
      messages.push({ role: "user", content: `q${i}` });
      messages.push({ role: "assistant", content: [use(`t${i}`, "get_restaurant_info", {})] });
      messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`, content: "{}" }] });
      messages.push({ role: "assistant", content: [say(`a${i}`)] });
    }
    const kept = trim(messages);
    expect(kept.length).toBeLessThanOrEqual(30);
    expect(typeof kept[0].content).toBe("string");
  });
});

describe("prompt", () => {
  test("includes today's date in Bulawayo time, so 'Saturday' can be worked out", () => {
    // 23:30 UTC on 27 November is already 28 November in Bulawayo.
    expect(systemPrompt(new Date("2026-11-27T23:30:00Z"))).toContain("2026-11-28");
  });
});

describe("WhatsApp", () => {
  test("reads text messages from a webhook delivery and skips everything else", () => {
    const payload = { entry: [{ changes: [{ value: { messages: [
      { from: "263771234567", id: "a", type: "text", text: { body: "Hi" } },
      { from: "263771234567", id: "b", type: "image", image: {} },
    ], statuses: [{}] } }] }] };
    expect(incomingMessages(payload)).toEqual([{ from: "263771234567", text: "Hi", id: "a" }]);
    expect(incomingMessages({})).toEqual([]);
  });

  test("turns local numbers into WhatsApp's international form", () => {
    expect(toWhatsAppNumber("077 123 4567")).toBe("263771234567");
    expect(toWhatsAppNumber("+263 77 123 4567")).toBe("263771234567");
  });
});
