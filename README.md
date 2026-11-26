# Copper Grill assistant

A WhatsApp booking assistant for The Copper Grill (iMBALi Mall, Bulawayo), built with Claude.
Guests message the restaurant in plain language ("table for 4 on Saturday at 7?") and the assistant
answers questions, checks real availability, books, cancels, and passes large groups to the team, all in
the restaurant's own booking system.

Built by Olidia Lunga.

## How it works

```
Guest on WhatsApp ──> this assistant ──> Claude (understands the message, decides what to do)
                           │
                           └──> The Copper Grill's booking API (/api/assistant) ──> its database
```

- **Claude decides, the booking system rules.** Claude chooses which action to take; every booking still goes
  through the restaurant's own rules (hours, party limits, no double bookings).
- **No invented facts.** The assistant answers only from the restaurant's own data. If a fact is missing, it
  says so.
- **Guests only touch their own bookings.** The phone number comes from WhatsApp, never from the model, and a
  booking can only be cancelled by the number that owns it.
- **Consent first.** Reminders go only to guests who said yes to WhatsApp messages.
- **Every exchange is logged** to `logs/turns.jsonl` (phone numbers shortened), for the accuracy log.

## Run it on your laptop

You need Node 24 or later, and The Copper Grill site running locally with `ASSISTANT_API_KEY` set in its
`.env.local` (see its `docs/assistant-api.md`).

```bash
npm install
copy .env.example .env      # Windows (use cp on Mac/Linux), then fill in .env
npm run dev
```

Open http://localhost:4000. It's a test chat that works like WhatsApp. Try:

- "Hi, what time do you open on Sunday?"
- "Can I get a table for 4 this Saturday at 7pm?"
- "Do I have any bookings?" then "Please cancel it"
- "We're 15 people for a year-end lunch on 12 December"

Change the phone number at the top to chat as a different guest. Check the results in the restaurant's
staff page (`/admin`), where WhatsApp bookings are labelled "Booked on WhatsApp".

## Commands

| Command | Does |
| --- | --- |
| `npm run dev` | Starts the assistant and test chat, restarting when files change |
| `npm test` | Runs the tests (no API key or database needed) |
| `npm run reminders` | Sends today's reminders (or lists them if WhatsApp isn't set up). Add a date: `npm run reminders -- 2026-12-05` |
| `npm run typecheck` | Checks the TypeScript |

## Files

| File | What it is |
| --- | --- |
| `src/prompt.ts` | The assistant's instructions: tone, rules, when to hand over to a person |
| `src/tools.ts` | The actions Claude may take, and the safety checks around them |
| `src/agent.ts` | The loop: send the message to Claude, run any actions, return the reply; short-term memory per guest |
| `src/grill.ts` | The client for the restaurant's booking API |
| `src/whatsapp.ts` | Reading WhatsApp messages and sending replies and reminders |
| `src/server.ts` | The web server: test chat page and the WhatsApp webhook |
| `src/reminders.ts` | The daily reminder job |
| `public/chat.html` | The test chat page |

## Connecting real WhatsApp (when the restaurant has its number)

1. In Meta for Developers, create an app with WhatsApp, and add the restaurant's WhatsApp Business number.
2. Put the access token and phone number ID in `.env` (`WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`), and choose
   a `WHATSAPP_VERIFY_TOKEN`.
3. Deploy the assistant somewhere with a public HTTPS address, and set the webhook URL to
   `https://<that address>/webhook` with the same verify token. Subscribe to `messages`.
4. For reminders, create a **utility** message template named `booking_reminder` with four variables, for
   example: *"Hi {{1}}, a reminder of your table for {{2}} at The Copper Grill today at {{3}}. View or cancel:
   {{4}}"*. WhatsApp only allows business-started messages through approved templates. Then schedule
   `npm run reminders` each morning.

Check Meta's current Graph API version and per-message prices for Zimbabwe before going live.

## Known limits (first version)

- Conversation memory is kept in the running process, so a restart forgets open chats (bookings are safe in
  the database).
- Text messages only; voice notes are planned.
- Shona and Ndebele replies depend on the model's ability in those languages and need testing with real guests.
