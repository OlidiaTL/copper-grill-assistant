import { appendFile, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

// The accuracy log: what guests asked and what the assistant answered, with personal
// details taken out, one file per day, deleted after LOG_KEEP_DAYS days.

/** Last four digits only: enough to tell guests apart in a log, not enough to contact them. */
export const shortPhone = (phone: string) => "…" + phone.slice(-4);

/**
 * Takes out what a log doesn't need: links (a booking's manage link lets anyone who has
 * it view or cancel the booking), email addresses and phone numbers.
 */
export function redact(text: string): string {
  return text
    .replace(/\bhttps?:\/\/\S+/gi, "[link]")
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, "[email]")
    // Phone numbers have at least 9 digits; dates (2026-12-05) and times have fewer, so they stay.
    .replace(/\+?\d[\d\s-]{7,}\d/g, (m) => (m.replace(/\D/g, "").length >= 9 ? "[number]" : m));
}

/** Tool inputs for the console: dates, times and sizes as they are; names, notes and emails only as a length. */
export function redactToolInput(input: unknown): Record<string, unknown> {
  const safe = new Set(["date", "time", "party_size", "whatsapp_consent"]);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries((input ?? {}) as Record<string, unknown>)) {
    out[key] = safe.has(key) ? value : typeof value === "string" ? `[${value.length} chars]` : "[hidden]";
  }
  return out;
}

const day = (now: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Harare" }).format(now);

export class TurnLog {
  private prunedOn = "";

  /** keepDays = 0 turns the log off. */
  constructor(
    private dir: string,
    private keepDays: number,
  ) {}

  async write(channel: string, phone: string, guest: string, answer: string, now = new Date()) {
    if (this.keepDays <= 0) return;
    await mkdir(this.dir, { recursive: true });
    const line = { at: now.toISOString(), channel, phone: shortPhone(phone), guest: redact(guest), answer: redact(answer) };
    await appendFile(join(this.dir, `turns-${day(now)}.jsonl`), JSON.stringify(line) + "\n");
    if (this.prunedOn !== day(now)) {
      this.prunedOn = day(now);
      await this.prune(now);
    }
  }

  /** Deletes daily log files older than keepDays. */
  async prune(now = new Date()) {
    const cutoff = day(new Date(now.getTime() - this.keepDays * 24 * 60 * 60 * 1000));
    for (const name of await readdir(this.dir).catch(() => [] as string[])) {
      const m = /^turns-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
      if (m && m[1] < cutoff) await rm(join(this.dir, name), { force: true });
    }
  }
}
