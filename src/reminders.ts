import { appendFile, mkdir, readFile } from "node:fs/promises";
import { grillClient } from "./grill.ts";
import { isSafeServiceUrl } from "./guard.ts";
import { sendTemplate, toInternational } from "./whatsapp.ts";

// Sends today's booking reminders on WhatsApp, to guests who agreed to them.
// Run once each morning: `npm run reminders` (or with a date: `npm run reminders -- 2026-12-05`).
// Without WhatsApp set up it only prints who would be reminded.
// Running it twice on the same day doesn't remind anyone twice: sent bookings are
// recorded in logs/reminders-sent-<date>.txt.

const env = (name: string, fallback = "") => process.env[name]?.trim() || fallback;

/** A value Meta accepts in a template: one line, no tabs, no long runs of spaces, not empty. */
const templateText = (value: string, fallback: string) => value.replace(/\s+/g, " ").trim().slice(0, 60) || fallback;

const date = process.argv[2] ?? new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Harare" }).format(new Date());
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error(`The date must be written YYYY-MM-DD, e.g. npm run reminders -- 2026-12-05 (got "${date}").`);
  process.exit(1);
}
const grillUrl = env("GRILL_URL", "http://localhost:3000");
if (!isSafeServiceUrl(grillUrl)) {
  console.error("GRILL_URL must start with https:// (http:// is only allowed for localhost).");
  process.exit(1);
}
const grill = grillClient(grillUrl, env("GRILL_API_KEY"));
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

const sentFile = `logs/reminders-sent-${date}.txt`;
const alreadySent = new Set((await readFile(sentFile, "utf8").catch(() => "")).split("\n").filter(Boolean));
if (whatsapp) await mkdir("logs", { recursive: true });

console.log(`${reminders.length} reminder(s) for ${date}${whatsapp ? "" : " (WhatsApp not set up: listing only)"}`);
let sent = 0;
let skipped = 0;
for (const r of reminders) {
  const to = toInternational(String(r.guestPhone ?? ""));
  const label = `  ${r.time}  ${r.partySize} guests, table ${r.table}  ->  ${to ? "…" + to.slice(-4) : "unusable number"}`;
  if (alreadySent.has(r.token)) {
    console.log(`${label}  (already reminded)`);
    continue;
  }
  // Never guess the country: a number like 082 123 4567 could be South African, and
  // turning it into a Zimbabwe number would send the guest's manage link to a stranger.
  if (!to) {
    console.warn(`${label}  SKIPPED: the number isn't in international form (+country code), so it can't be messaged safely.`);
    skipped++;
    continue;
  }
  console.log(label);
  if (!whatsapp) continue;
  // Template body, e.g.: "Hi {{1}}, a reminder of your table for {{2}} at The Copper Grill today at {{3}}. View or cancel: {{4}}"
  const firstName = templateText(String(r.guestName ?? "").trim().split(/\s+/)[0] ?? "", "there");
  const ok = await sendTemplate(whatsapp, to, env("WHATSAPP_REMINDER_TEMPLATE", "booking_reminder"), [
    firstName,
    String(r.partySize),
    templateText(String(r.time), "your booked time"),
    templateText(String(r.manageUrl), "-"),
  ]).catch(() => false);
  if (ok) {
    sent++;
    await appendFile(sentFile, r.token + "\n");
  }
}
if (whatsapp) console.log(`Sent ${sent} of ${reminders.length}${skipped ? `; ${skipped} skipped (see above)` : ""}.`);
else if (skipped) console.log(`${skipped} would be skipped (see above).`);
