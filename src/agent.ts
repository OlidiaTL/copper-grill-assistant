import type Anthropic from "@anthropic-ai/sdk";
import type { Grill } from "./grill.ts";
import { systemPrompt } from "./prompt.ts";
import { runTool, tools } from "./tools.ts";

// One guest message in, one reply out. Claude may call tools (check times, book,
// cancel...) several times before it answers; this loop runs them and feeds the
// results back until Claude replies in words.

type Model = Pick<Anthropic["messages"], "create">;

export type AgentDeps = {
  model: Model;
  modelName: string;
  grill: Grill;
  now?: () => Date;
  /** Called for every tool use, for logging and the accuracy log. */
  onTool?: (event: { phone: string; name: string; input: unknown; isError: boolean }) => void;
};

const MAX_STEPS = 8;
const KEEP_MESSAGES = 30;
const FORGET_AFTER_MS = 2 * 60 * 60 * 1000;

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
    this.byPhone.set(phone, { messages: trim(messages), lastSeen: now });
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

export async function reply(
  deps: AgentDeps,
  conversations: Conversations,
  phone: string,
  text: string,
): Promise<string> {
  const now = deps.now?.() ?? new Date();
  const messages: Anthropic.MessageParam[] = [...conversations.get(phone, now.getTime()), { role: "user", content: text }];

  for (let step = 0; step < MAX_STEPS; step++) {
    const response = await deps.model.create({
      model: deps.modelName,
      max_tokens: 1024,
      system: systemPrompt(now),
      tools,
      messages,
    });
    messages.push({ role: "assistant", content: response.content });

    const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
      conversations.set(phone, messages, now.getTime());
      const words = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      return words || "Sorry, I didn't catch that. Could you say it another way?";
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const use of toolUses) {
      let result: { content: string; isError: boolean };
      try {
        result = await runTool(deps.grill, phone, use.name, (use.input ?? {}) as Record<string, unknown>);
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
