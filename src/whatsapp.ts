// WhatsApp Cloud API (Meta): reading incoming messages from the webhook, and sending replies.
// Docs: developers.facebook.com/docs/whatsapp/cloud-api

export type WhatsAppConfig = {
  token: string;
  phoneNumberId: string;
  graphVersion: string;
};

export type Incoming = { from: string; text: string; id: string };

/** Pulls the text messages out of a webhook delivery. Other kinds (status updates, images) are skipped. */
export function incomingMessages(payload: unknown): Incoming[] {
  const found: Incoming[] = [];
  const entries = (payload as { entry?: unknown[] })?.entry ?? [];
  for (const entry of entries as { changes?: { value?: { messages?: unknown[] } }[] }[]) {
    for (const change of entry.changes ?? []) {
      for (const m of (change.value?.messages ?? []) as { from?: string; id?: string; type?: string; text?: { body?: string } }[]) {
        if (m.type === "text" && m.from && m.text?.body) found.push({ from: m.from, text: m.text.body, id: m.id ?? "" });
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

/** WhatsApp numbers arrive as digits only (e.g. 263771234567). */
export const toWhatsAppNumber = (phone: string) => {
  const digits = phone.replace(/\D/g, "");
  return digits.startsWith("0") ? "263" + digits.slice(1) : digits;
};
