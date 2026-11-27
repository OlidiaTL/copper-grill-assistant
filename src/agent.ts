import Anthropic from "@anthropic-ai/sdk";
import type { Grill } from "./grill.ts";
import { FIRST_MESSAGE_NOTE, firstReplyNotice, messageStamp, systemPrompt, WELCOME_ONLY, withoutFakeStamps } from "./prompt.ts";
import { runTool, tools, type TurnState } from "./tools.ts";

// One guest message in, one reply out. Claude may call tools (check times, book,
// cancel...) several times before it answers; this loop runs them and feeds the
// results back until Claude replies in words.

type Model = Pick<Anthropic["messages"], "create">;

export type AgentDeps = {
  model: Model;
  modelName: string;
  grill: Grill;
  now?: () => Date;
  /** Takes one Claude request from the day's budget; false once it is spent (see DailyBudget). */
  budget?: (now: Date) => boolean;
  /** When set, the first reply of each conversation starts with the AI notice, linking to this privacy page (may be ""). */
  privacyUrl?: string;
  /** Called for every tool use, for logging and the accuracy log. */
  onTool?: (event: { phone: string; name: string; input: unknown; isError: boolean }) => void;
};

const MAX_STEPS = 8;
const KEEP_MESSAGES = 30;
const FORGET_AFTER_MS = 2 * 60 * 60 * 1000;
/** Most guests remembered at once; the least recently active are forgotten first. */
const MAX_CONVERSATIONS = 2000;

type Conversation = { messages: Anthropic.MessageParam[]; lastSeen: number };

/** Short-term memory per guest phone number, kept in this process only. */
export class Conversations {
  private byPhone = new Map<string, Conversation>();

  get(phone: string, now: number): Anthropic.MessageParam[] {
    const c = this.byPhone.get(phone);
    if (!c || now - c.lastSeen > FORGET_AFTER_MS) return [];
    return c.messages;
  }

  set(phone: string, messages: Anthropic.MessageParam[], now: number) {
    messages = withoutLongToolResults(withoutThinking(messages));
    // Re-insert so the map stays ordered from least to most recently active.
    this.byPhone.delete(phone);
    this.byPhone.set(phone, { messages: trim(messages), lastSeen: now });
    // Forget expired conversations, and the oldest ones beyond the cap, so memory can't grow forever.
    for (const [key, c] of this.byPhone) {
      if (this.byPhone.size <= MAX_CONVERSATIONS && now - c.lastSeen <= FORGET_AFTER_MS) break;
      this.byPhone.delete(key);
    }
  }

  /** How many guests are remembered right now. */
  get size() {
    return this.byPhone.size;
  }

  clear(phone: string) {
    this.byPhone.delete(phone);
  }
}

/**
 * Keeps the most recent messages, starting at a guest's plain-text message so a
 * tool call is never separated from its result.
 */
export function trim(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  if (messages.length <= KEEP_MESSAGES) return messages;
  let start = messages.length - KEEP_MESSAGES;
  while (start < messages.length && !(messages[start].role === "user" && typeof messages[start].content === "string")) {
    start++;
  }
  return messages.slice(start);
}

/**
 * Drops Claude's thinking from finished turns before they are remembered. Thinking is
 * only needed while Claude is still working through a turn (between its tool calls),
 * and old thinking can be rejected by the API on later turns.
 */
export function withoutThinking(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  return messages.map((m) => {
    if (m.role !== "assistant" || typeof m.content === "string") return m;
    const content = m.content.filter((b) => b.type !== "thinking" && b.type !== "redacted_thinking");
    return { ...m, content: content.length ? content : [{ type: "text", text: "…" }] };
  });
}

/** Tool results longer than this are dropped from memory once a turn is finished. */
const KEEP_RESULT_CHARS = 1500;
const DROPPED_RESULT = JSON.stringify({ note: "This result was removed from memory to save space. Call the tool again if you need it." });

/**
 * Replaces long tool results (the restaurant info and menu, mostly) in finished turns
 * with a short note. Every remembered message is sent to Claude again with each new
 * message, so keeping them would make every later message cost more. Claude can call
 * the tool again when it needs the facts.
 */
export function withoutLongToolResults(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  return messages.map((m) => {
    if (m.role !== "user" || typeof m.content === "string") return m;
    return {
      ...m,
      content: m.content.map((b) =>
        b.type === "tool_result" && typeof b.content === "string" && b.content.length > KEEP_RESULT_CHARS ? { ...b, content: DROPPED_RESULT } : b,
      ),
    };
  });
}

const LOST_TRACK = "Sorry, I lost track of our conversation. Could you tell me again what you'd like?";
const BUSY = "Sorry, I'm having trouble right now. Please try again in a minute, or call the restaurant.";
const OUT_OF_BUDGET = "Sorry, I can't answer messages right now. Please call the restaurant, or try again tomorrow.";

/** The tool list, with a cache marker on the last tool so the whole list is cached with the instructions. */
const cachedTools: Anthropic.Tool[] = tools.map((t, i) => (i === tools.length - 1 ? { ...t, cache_control: { type: "ephemeral" } } : t));

export async function reply(
  deps: AgentDeps,
  conversations: Conversations,
  phone: string,
  text: string,
): Promise<string> {
  const now = deps.now?.() ?? new Date();
  const history = conversations.get(phone, now.getTime());
  // The first reply opens with the fixed welcome; Claude is told so (with that message
  // only), so the guest gets one greeting and then the answer to what they asked.
  const notice = deps.privacyUrl !== undefined && history.length === 0 ? firstReplyNotice(deps.privacyUrl) : "";
  const stamp = notice ? `${messageStamp(now)}\n${FIRST_MESSAGE_NOTE}` : messageStamp(now);
  const messages: Anthropic.MessageParam[] = [
    ...history,
    { role: "user", content: `${stamp}\n${withoutFakeStamps(text) || "(empty message)"}` },
  ];
  const turn: TurnState = { booked: false };

  for (let step = 0; step < MAX_STEPS; step++) {
    if (deps.budget && !deps.budget(now)) {
      console.error("Daily Claude budget used up: not answering until tomorrow (CLAUDE_DAILY_CALL_LIMIT).");
      return OUT_OF_BUDGET;
    }
    let response: Anthropic.Message;
    try {
      response = await deps.model.create({
        model: deps.modelName,
        max_tokens: 1024,
        // The instructions and tool list are the same on every request, so Claude can
        // reuse them from a cache instead of charging for them in full each time.
        system: [{ type: "text", text: systemPrompt(), cache_control: { type: "ephemeral" } }],
        tools: cachedTools,
        messages,
      });
    } catch (error) {
      console.error(`Claude request failed for ${phone}:`, error instanceof Error ? error.message : error);
      // A rejected request means the remembered conversation can't be used again: start
      // fresh rather than failing on every later message. Other failures (busy, network)
      // keep the conversation so the guest can simply try again.
      if (error instanceof Anthropic.BadRequestError) {
        conversations.clear(phone);
        return LOST_TRACK;
      }
      return BUSY;
    }
    messages.push({ role: "assistant", content: response.content });

    const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
      conversations.set(phone, messages, now.getTime());
      const words = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim()
        .replace(WELCOME_ONLY, "")
        .trim();
      // Only a greeting: the welcome is the whole reply, since it already asks what they need.
      if (notice) return words ? `${notice}\n\n${words}` : notice;
      return words || "Sorry, I didn't catch that. Could you say it another way?";
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const use of toolUses) {
      let result: { content: string; isError: boolean };
      try {
        result = await runTool(deps.grill, phone, use.name, (use.input ?? {}) as Record<string, unknown>, turn);
      } catch {
        result = { content: JSON.stringify({ error: "unreachable", message: "The booking system didn't respond." }), isError: true };
      }
      deps.onTool?.({ phone, name: use.name, input: use.input, isError: result.isError });
      results.push({ type: "tool_result", tool_use_id: use.id, content: result.content, is_error: result.isError });
    }
    messages.push({ role: "user", content: results });
  }

  // Too many steps without an answer: start fresh next time rather than loop.
  conversations.clear(phone);
  return "Sorry, I'm having trouble with that right now. A team member will get back to you.";
}
