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
        party_size: { type: "integer", minimum: 1 },
      },
      required: ["date", "party_size"],
    },
  },
  {
    name: "create_booking",
    description:
      "Books the best free table. Only call this after the guest has clearly confirmed the date, time, party size " +
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

/** Runs one tool for the guest messaging from `phone` and returns what to tell the model. */
export async function runTool(
  grill: Grill,
  phone: string,
  name: string,
  input: Input,
): Promise<{ content: string; isError: boolean }> {
  const reply = (r: { ok: boolean; body: unknown }) => ({ content: JSON.stringify(r.body), isError: !r.ok });

  switch (name) {
    case "get_restaurant_info":
      return reply(await grill.info());

    case "check_availability":
      return reply(await grill.availability(String(input.date ?? ""), Number(input.party_size)));

    case "create_booking":
      return reply(
        await grill.book({
          date: str(input.date),
          time: str(input.time),
          partySize: Number(input.party_size),
          guestName: str(input.guest_name),
          guestPhone: phone,
          whatsappConsent: input.whatsapp_consent === true,
          occasion: str(input.occasion),
          notes: str(input.notes),
          guestEmail: str(input.email),
        }),
      );

    case "find_my_bookings":
      return reply(await grill.bookingsFor(phone));

    case "cancel_booking": {
      // Only a booking that belongs to this number may be cancelled.
      const token = String(input.token ?? "");
      const mine = await grill.bookingsFor(phone);
      if (!mine.body.bookings?.some((b) => b.token === token)) {
        return { content: JSON.stringify({ error: "not_yours", message: "That isn't one of this guest's upcoming bookings." }), isError: true };
      }
      return reply(await grill.cancel(token));
    }

    case "send_group_enquiry":
      return reply(
        await grill.enquiry({
          name: str(input.name),
          phone,
          partySize: Number(input.party_size),
          date: str(input.date),
          message: str(input.message),
        }),
      );

    default:
      return { content: JSON.stringify({ error: "unknown_tool" }), isError: true };
  }
}
