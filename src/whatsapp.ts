// WhatsApp Cloud API (Meta): reading incoming messages from the webhook, and sending replies.
// Docs: developers.facebook.com/docs/whatsapp/cloud-api

export type WhatsAppConfig = {
  token: string;
  phoneNumberId: string;
  graphVersion: string;
};

/**
 * One message from a guest. `text` is null for kinds the assistant can't read yet
 * (voice notes, photos, locations...), so it can say so instead of staying silent.
 */
export type Incoming = { from: string; text: string | null; id: string; sentAt: number };

/** Message kinds that need no answer at all (a guest reacting with an emoji, for example). */
const NO_REPLY_KINDS = new Set(["reaction", "system", "ephemeral"]);

type RawMessage = { from?: unknown; id?: unknown; type?: unknown; timestamp?: unknown; text?: { body?: unknown } };
type RawValue = { metadata?: { phone_number_id?: unknown }; messages?: RawMessage[] };

/**
 * Pulls the guests' messages out of a webhook delivery. Status updates are skipped.
 * With `phoneNumberId`, only messages sent to that WhatsApp number are kept, in case
 * the Meta app has other numbers too.
 */
export function incomingMessages(payload: unknown, phoneNumberId?: string): Incoming[] {
  const found: Incoming[] = [];
  const entries = (payload as { entry?: unknown })?.entry;
  if (!Array.isArray(entries)) return found;
  for (const entry of entries as { changes?: { value?: RawValue }[] }[]) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      const value = change?.value;
      if (phoneNumberId && value?.metadata?.phone_number_id !== phoneNumberId) continue;
      for (const m of Array.isArray(value?.messages) ? value.messages : []) {
        if (typeof m?.from !== "string" || !/^\d{6,15}$/.test(m.from) || typeof m.id !== "string" || !m.id) continue;
        if (typeof m.type !== "string" || NO_REPLY_KINDS.has(m.type)) continue;
        const body = m.type === "text" && typeof m.text?.body === "string" && m.text.body.trim() ? m.text.body : null;
        const seconds = Number(m.timestamp);
        found.push({ from: m.from, text: body, id: m.id, sentAt: Number.isFinite(seconds) ? seconds * 1000 : Date.now() });
      }
    }
  }
  return found;
}

/** Messages a guest who wrote in the last 24 hours. Business-started messages need a template (see sendTemplate). */
export async function sendText(config: WhatsAppConfig, to: string, body: string): Promise<boolean> {
  return send(config, { messaging_product: "whatsapp", to, type: "text", text: { body } });
}

/** Sends an approved message template, for reminders the business starts. */
export async function sendTemplate(
  config: WhatsAppConfig,
  to: string,
  template: string,
  parameters: string[],
  language = "en",
): Promise<boolean> {
  return send(config, {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: template,
      language: { code: language },
      components: [{ type: "body", parameters: parameters.map((text) => ({ type: "text", text })) }],
    },
  });
}

async function send(config: WhatsAppConfig, message: unknown): Promise<boolean> {
  const url = `https://graph.facebook.com/${config.graphVersion}/${config.phoneNumberId}/messages`;
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) console.error("WhatsApp send failed", response.status, await response.text().catch(() => ""));
  return response.ok;
}

/** Zimbabwe mobile numbers written the local way: 071, 073, 077 or 078 and seven more digits. */
const ZIMBABWE_LOCAL_MOBILE = /^07[1378]\d{7}$/;

/**
 * A phone number in WhatsApp's international form (digits only, e.g. 263771234567),
 * or null if the country can't be known for sure. Never guesses: "082 123 4567" could
 * be South African and "07911 123456" British, and turning those into Zimbabwe numbers
 * would message a stranger.
 */
export function toInternational(phone: string): string | null {
  const trimmed = phone.trim();
  const digits = trimmed.replace(/\D/g, "");
  let international: string;
  if (trimmed.startsWith("+")) international = digits;
  else if (digits.startsWith("00")) international = digits.slice(2);
  else if (ZIMBABWE_LOCAL_MOBILE.test(digits)) international = "263" + digits.slice(1);
  else if (!digits.startsWith("0")) international = digits;
  else return null;
  // International numbers are 8 to 15 digits and never start with 0.
  return /^[1-9]\d{7,14}$/.test(international) ? international : null;
}
