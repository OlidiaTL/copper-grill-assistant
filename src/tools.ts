import type Anthropic from "@anthropic-ai/sdk";
import type { Grill } from "./grill.ts";

// The actions Claude may take for a guest. Each tool maps to one call on the
// restaurant's API. The guest's phone number never comes from the model: it is
// the number the message arrived from, so a guest can only see and cancel their
// own bookings.

export const tools: Anthropic.Tool[] = [
  {
    name: "get_restaurant_info",
    description:
      "Facts about The Copper Grill: address, opening hours and services, booking rules (largest party online, " +
      "how far ahead, late arrival grace), FAQ, parking and entrance notes, and the menu. Use it before answering " +
      "any factual question. If a fact is null or missing here, you do not know it. If menuIsSample is true, the " +
      "menu is a placeholder: describe it only as a sample and never quote its prices as real.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "check_availability",
    description:
      "The times still bookable on a date for a party size. Returns a list of HH:MM times. An error of " +
      "'large_party' means the group is too big to book directly: offer to pass a group enquiry to the team instead.",
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Restaurant-local date, YYYY-MM-DD" },
        party_size: { type: "integer", minimum: 1, maximum: 100 },
      },
      required: ["date", "party_size"],
    },
  },
  {
    name: "create_booking",
    description:
      "Books the best free table. Book one table per guest message at most. Only call this after the guest has clearly confirmed the date, time, party size " +
      "and name, and you have asked whether they would like a confirmation and a reminder on WhatsApp.",
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "YYYY-MM-DD" },
        time: { type: "string", description: "HH:MM, one of the times check_availability returned" },
        party_size: { type: "integer", minimum: 1 },
        guest_name: { type: "string" },
        whatsapp_consent: {
          type: "boolean",
          description: "True only if the guest said yes to a confirmation and reminder on WhatsApp",
        },
        occasion: { type: "string", description: "Optional, e.g. birthday" },
        notes: { type: "string", description: "Optional requests, e.g. high chair, allergy to mention to staff" },
        email: { type: "string", description: "Optional, only if the guest gives one" },
      },
      required: ["date", "time", "party_size", "guest_name", "whatsapp_consent"],
    },
  },
  {
    name: "find_my_bookings",
    description:
      "The guest's upcoming bookings (made on WhatsApp or the website), found by the number they are messaging from.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "cancel_booking",
    description:
      "Cancels one of the guest's own upcoming bookings. Use the token from find_my_bookings, and only after the " +
      "guest has confirmed which booking to cancel.",
    input_schema: {
      type: "object",
      properties: { token: { type: "string" } },
      required: ["token"],
    },
  },
  {
    name: "send_group_enquiry",
    description:
      "Passes a request for a group too large to book directly to the restaurant team, who will reply. Collect the " +
      "name, party size and preferred date first.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        party_size: { type: "integer", minimum: 1 },
        date: { type: "string", description: "Optional, YYYY-MM-DD" },
        message: { type: "string", description: "Optional details, e.g. occasion, budget, time" },
      },
      required: ["name", "party_size"],
    },
  },
];

type Input = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** Longest text the assistant passes on, so a guest can't store pages of text in a booking. */
export const LIMITS = { name: 80, occasion: 80, notes: 300, email: 254, message: 1000 } as const;
/** Largest party the assistant will even ask about; the booking system has its own, lower, online limit. */
export const MAX_PARTY = 100;
/** Upcoming bookings one number may hold through the assistant. More than this goes to the team. */
export const MAX_UPCOMING_BOOKINGS = 3;

const invalid = (message: string) => ({ content: JSON.stringify({ error: "invalid_input", message }), isError: true });

/** A real calendar date written YYYY-MM-DD. */
export function isDate(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(v + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** A clock time written HH:MM (24-hour). */
export const isTime = (v: unknown): v is string => typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);

const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

const isPartySize = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= MAX_PARTY;

/** "7:00", "07:00" and "07:00:00" are the same time. */
export function sameTime(a: unknown, b: unknown): boolean {
  const norm = (v: unknown) => {
    const m = typeof v === "string" ? /^(\d{1,2}):(\d{2})/.exec(v.trim()) : null;
    return m ? `${m[1].padStart(2, "0")}:${m[2]}` : null;
  };
  const x = norm(a);
  return x !== null && x === norm(b);
}

/** What happened earlier in the same guest message, so one message can't make several bookings. */
export type TurnState = { booked: boolean };

/** Runs one tool for the guest messaging from `phone` and returns what to tell the model. */
export async function runTool(
  grill: Grill,
  phone: string,
  name: string,
  input: Input,
  turn: TurnState = { booked: false },
): Promise<{ content: string; isError: boolean }> {
  const reply = (r: { ok: boolean; body: unknown }) => ({ content: JSON.stringify(r.body), isError: !r.ok });

  switch (name) {
    case "get_restaurant_info":
      return reply(await grill.info());

    case "check_availability":
      if (!isDate(input.date)) return invalid("date must be a real date written YYYY-MM-DD.");
      if (!isPartySize(input.party_size)) return invalid(`party_size must be a whole number from 1 to ${MAX_PARTY}.`);
      return reply(await grill.availability(input.date, input.party_size));

    case "create_booking": {
      const partySize = input.party_size;
      if (!isPartySize(partySize)) return invalid(`party_size must be a whole number of guests, from 1 to ${MAX_PARTY}.`);
      if (!isDate(input.date)) return invalid("date must be a real date written YYYY-MM-DD.");
      if (!isTime(input.time)) return invalid("time must be written HH:MM (24-hour), one of the times check_availability returned.");
      const name = str(input.guest_name)?.trim() ?? "";
      if (!name || name.length > LIMITS.name) return invalid(`guest_name is needed, up to ${LIMITS.name} characters.`);
      for (const [field, max] of [["occasion", LIMITS.occasion], ["notes", LIMITS.notes], ["email", LIMITS.email]] as const) {
        const value = str(input[field]);
        if (value && value.length > max) return invalid(`${field} must be ${max} characters or fewer.`);
      }
      const email = str(input.email)?.trim();
      if (email && !isEmail(email)) return invalid("email doesn't look like an email address; leave it out if the guest didn't give one.");

      // Never book the same slot twice for one guest: a repeated request (the guest
      // saying yes twice, or a retry after a slow reply) gets the existing booking back.
      const existing = await grill.bookingsFor(phone);
      if (!existing.ok) {
        return { content: JSON.stringify({ error: "unavailable", message: "Couldn't check the guest's existing bookings, so nothing was booked. Ask them to try again shortly." }), isError: true };
      }
      const upcoming = (existing.body.bookings ?? []).filter((b) => b.status === "confirmed");
      const same = upcoming.find((b) => b.date === input.date && sameTime(b.time, input.time));
      if (same) {
        return { content: JSON.stringify({ ok: true, alreadyBooked: true, booking: same }), isError: false };
      }
      // One new booking per guest message, however many the model asks for.
      if (turn.booked) {
        return {
          content: JSON.stringify({ error: "one_booking_per_message", message: "Only one table can be booked per message. Book the others one at a time, after the guest confirms each." }),
          isError: true,
        };
      }
      if (upcoming.length >= MAX_UPCOMING_BOOKINGS) {
        return {
          content: JSON.stringify({
            error: "too_many_bookings",
            message: `This number already has ${upcoming.length} upcoming bookings, the most allowed on WhatsApp. Offer to cancel one, or pass the request to the team with send_group_enquiry.`,
          }),
          isError: true,
        };
      }
      // Counted before the call: if it times out, the booking may exist, so no second try in this message.
      turn.booked = true;

      try {
        return reply(
          await grill.book({
            date: input.date,
            time: input.time,
            partySize,
            guestName: name,
            guestPhone: phone,
            whatsappConsent: input.whatsapp_consent === true,
            occasion: str(input.occasion),
            notes: str(input.notes),
            guestEmail: email || undefined,
          }),
        );
      } catch {
        // The booking may or may not have been saved. Don't guess and don't retry blindly.
        return {
          content: JSON.stringify({
            error: "outcome_unknown",
            message: "The booking system didn't answer in time, so it isn't known whether the table was booked. Call find_my_bookings to check before trying again.",
          }),
          isError: true,
        };
      }
    }

    case "find_my_bookings":
      return reply(await grill.bookingsFor(phone));

    case "cancel_booking": {
      // Only a booking that belongs to this number may be cancelled.
      const token = str(input.token)?.trim() ?? "";
      if (!token || token.length > 200) return invalid("token must be one of the tokens find_my_bookings returned.");
      const mine = await grill.bookingsFor(phone);
      if (!mine.ok) return { content: JSON.stringify({ error: "unavailable", message: "Couldn't check the guest's bookings; nothing was cancelled." }), isError: true };
      if (!mine.body.bookings?.some((b) => b.token === token)) {
        return { content: JSON.stringify({ error: "not_yours", message: "That isn't one of this guest's upcoming bookings." }), isError: true };
      }
      return reply(await grill.cancel(token, phone));
    }

    case "send_group_enquiry": {
      const partySize = input.party_size;
      if (!isPartySize(partySize)) return invalid(`party_size must be a whole number of guests, from 1 to ${MAX_PARTY}.`);
      if (input.date !== undefined && input.date !== "" && !isDate(input.date)) return invalid("date must be a real date written YYYY-MM-DD, or left out.");
      const name = str(input.name)?.trim() ?? "";
      if (!name || name.length > LIMITS.name) return invalid(`name is needed, up to ${LIMITS.name} characters.`);
      const message = str(input.message);
      if (message && message.length > LIMITS.message) return invalid(`message must be ${LIMITS.message} characters or fewer.`);
      return reply(
        await grill.enquiry({ name, phone, partySize, date: str(input.date) || undefined, message }),
      );
    }

    default:
      return { content: JSON.stringify({ error: "unknown_tool" }), isError: true };
  }
}
