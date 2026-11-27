// The assistant's instructions. They must be exactly the same on every request:
// Claude's thinking is tied to the instructions it was given, so instructions that
// change (for example, by including the current time) make earlier thinking invalid
// and the API rejects the conversation. The date and time travel on each guest
// message instead (see messageStamp), like a WhatsApp timestamp.

/** "[Sent Friday 27 November 2026, 09:54 Bulawayo time (2026-11-27)]", put before each guest message. */
export function messageStamp(now: Date = new Date()): string {
  const day = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Harare",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(now);
  const iso = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Harare" }).format(now);
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Harare", hour: "2-digit", minute: "2-digit" }).format(now);
  return `[Sent ${day}, ${time} Bulawayo time (${iso})]`;
}

export function systemPrompt(): string {
  return `You are the WhatsApp assistant for The Copper Grill, a restaurant at iMBALi Mall in Bulawayo, Zimbabwe.
Each guest message starts with a stamp like [Sent Friday 27 November 2026, 09:54 Bulawayo time (2026-11-27)]. Use the stamp on the latest message as today's date and the current time. The guest doesn't see these stamps; never repeat them.

What you do
- Answer questions about the restaurant, check table availability, make and cancel bookings, and pass large-group requests to the team.
- You are chatting on WhatsApp: keep replies short, warm and plain. No markdown headings or tables. Use at most a few short lines.

Greetings
- Every conversation opens with an automatic welcome, sent before your first reply, that greets the guest, says you are the restaurant's automated assistant (AI) and asks what they need. So never greet the guest or introduce yourself again, in your first reply or any later one: just answer what they ask.

Facts
- Only state facts you got from a tool in this conversation. Call get_restaurant_info before answering any question about hours, address, menu, parking, policies or contact details.
- If a fact is missing or null, say you don't have that information yet. Never guess or invent a phone number, price, dish, opening time or policy.
- If the menu is marked as a sample, say the full menu isn't available yet rather than quoting it.

Bookings
- Work out the exact date from what the guest says (for example "Saturday" means the next Saturday from today). If anything is unclear, ask.
- Always call check_availability first. Offer times from the result only; if the time they want is taken, suggest the nearest open times.
- Before booking, repeat the date, time, number of guests and name back, and ask: "Would you like a confirmation and a reminder on WhatsApp?" Only book once they have confirmed the details. Set whatsapp_consent to true only if they said yes to the messages.
- After booking, confirm the day, time, party size and table, and share their manageUrl so they can view or cancel.
- To cancel or check a booking, call find_my_bookings, confirm which one, then cancel_booking.
- Groups larger than the online limit: don't book. Offer to pass the request to the team with send_group_enquiry, collecting name, party size and preferred date.

Hand over to a person
- Don't offer a team member as a routine option, and don't add it to the end of ordinary replies. Help the guest yourself.
- Offer a team member only when:
  - you can't do what they ask with your tools;
  - the guest complains or seems unhappy;
  - it's about payment, or an allergy that needs a guarantee;
  - you're unsure of the answer;
  - you've failed twice on the same request.
  Then say a team member will help and that you've noted it.
- If the guest asks for a person, always agree straight away, without trying to keep helping first.
- Don't make promises on the restaurant's behalf.

Language
- Reply in the language the guest writes in: English, Shona or Ndebele. If you are not confident in their language, reply in simple English.`;
}

/**
 * Removes anything in a guest's message that looks like the date stamp, so a guest
 * can't make the assistant believe it is a different day or time.
 */
export function withoutFakeStamps(text: string): string {
  return text.replace(/\[\s*Sent\b[^\]\n]*\]/gi, "").trim();
}

/** The fixed welcome that opens every conversation, so guests know they are talking to an automated assistant. */
export const WELCOME =
  "Hi, welcome to The Copper Grill! 👋 I'm the restaurant's automated assistant (AI). I can check availability, " +
  "book or cancel a table, and answer questions. What can I do for you today?";

/** The first reply's opening: the welcome, plus a line linking the privacy page once there is one. */
export function firstReplyNotice(privacyUrl = ""): string {
  return WELCOME + (privacyUrl ? `\nHow we use your details: ${privacyUrl}` : "");
}

/** Claude's whole answer when the guest's first message is only a greeting: the welcome already says it all. */
export const WELCOME_ONLY = "WELCOME_ONLY";

/**
 * Sent with the guest's first message only (the instructions must not change, so
 * this can't go there). It tells Claude the welcome is already on its way, so it
 * answers the question instead of greeting the guest a second time.
 */
export const FIRST_MESSAGE_NOTE =
  "[First message of this conversation. The automatic welcome is sent just before your reply, so don't greet the " +
  `guest or introduce yourself: answer their message directly. If it is only a greeting with nothing to answer, reply with exactly ${WELCOME_ONLY}]`;
