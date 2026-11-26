import { grillClient } from "./grill.ts";
import { sendTemplate, toWhatsAppNumber } from "./whatsapp.ts";

// Sends today's booking reminders on WhatsApp, to guests who agreed to them.
// Run once each morning: `npm run reminders` (or with a date: `npm run reminders -- 2026-12-05`).
// Without WhatsApp set up it only prints who would be reminded.

const env = (name: string, fallback = "") => process.env[name]?.trim() || fallback;

const date = process.argv[2] ?? new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Harare" }).format(new Date());
const grill = grillClient(env("GRILL_URL", "http://localhost:3000"), env("GRILL_API_KEY"));
const result = await grill.reminders(date);
if (!result.ok) {
  console.error("Couldn't read reminders:", result.status, JSON.stringify(result.body));
  process.exit(1);
}

const reminders = result.body.reminders ?? [];
const whatsapp =
  env("WHATSAPP_TOKEN") && env("WHATSAPP_PHONE_NUMBER_ID")
    ? { token: env("WHATSAPP_TOKEN"), phoneNumberId: env("WHATSAPP_PHONE_NUMBER_ID"), graphVersion: env("WHATSAPP_GRAPH_VERSION", "v23.0") }
    : null;

console.log(`${reminders.length} reminder(s) for ${date}${whatsapp ? "" : " (WhatsApp not set up: listing only)"}`);
let sent = 0;
for (const r of reminders) {
  const firstName = r.guestName.split(" ")[0];
  console.log(`  ${r.time}  ${r.guestName}, ${r.partySize} guests, table ${r.table}  ->  ${r.guestPhone}`);
  if (!whatsapp) continue;
  // Template body, e.g.: "Hi {{1}}, a reminder of your table for {{2}} at The Copper Grill today at {{3}}. View or cancel: {{4}}"
  const ok = await sendTemplate(whatsapp, toWhatsAppNumber(r.guestPhone), env("WHATSAPP_REMINDER_TEMPLATE", "booking_reminder"), [
    firstName,
    String(r.partySize),
    r.time,
    r.manageUrl,
  ]);
  if (ok) sent++;
}
if (whatsapp) console.log(`Sent ${sent} of ${reminders.length}.`);
