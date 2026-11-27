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
- **Guests know it's automated.** The first reply of each conversation says it's an AI assistant, with a link to
  the privacy page if `PRIVACY_URL` is set.
- **Every exchange is logged** to `logs/turns-<date>.jsonl` for the accuracy log, with links, emails and phone
  numbers taken out and only the last four digits of the guest's number. Files are deleted after `LOG_KEEP_DAYS`
  (30 by default; 0 turns the log off).

## Security

Added after two independent security reviews (27 November 2026):

| Protection | Stops |
| --- | --- |
| WhatsApp deliveries must carry Meta's signature (`X-Hub-Signature-256`, checked with `WHATSAPP_APP_SECRET`); without the secret the webhook refuses everything | Anyone faking a message "from" a guest's number to read or cancel their bookings |
| The test chat is off unless `TEST_CHAT=1`, and only answers requests from the same machine; the server listens on `127.0.0.1` unless `HOST` says otherwise | Someone on the network using the test chat to pose as any number |
| 30 messages per number per hour, 1,500 characters per message, 1 MB per request | One person running up the Claude bill or flooding the assistant |
| One message at a time per number | Two messages arriving together both booking |
| Same guest, same date and time: the existing booking is returned instead of a second one; if the booking system times out, Claude is told to check before retrying | Double bookings from repeats and retries |
| Party size must be a real whole number; names, notes and messages have length limits | Junk or oversized data reaching the booking system |
| Conversations, message ids and counters are capped and forgotten over time | Memory growing until the server falls over |
| The test chat refuses requests passed on by a tunnel or proxy (ngrok, cloudflared, nginx), requests not addressed to `localhost`, and requests from other web pages; the assistant won't start with `TEST_CHAT=1` unless `HOST` is `127.0.0.1` | The test chat being reachable from the internet while a tunnel is open, or driven by a website open in your browser |
| One new booking per guest message, and at most 3 upcoming bookings per number; nothing is booked if the guest's existing bookings can't be checked | One message (or one guest) booking out a whole evening |
| Repeats are spotted even when times are written differently (`19:00` and `19:00:00`) | Double bookings slipping past the repeat check |
| Dates, times, party sizes (1 to 100) and emails must be well formed for every action | Junk reaching the booking system |
| Text in a guest's message that looks like the date stamp is removed | A guest making the assistant believe it's another day |
| Each WhatsApp message is handled on its own, and a failed reply is retried once | One failure losing other guests' messages |
| WhatsApp messages over 24 hours old, sent to another number on the Meta app, or malformed are ignored; voice notes and photos get "text only, please" | Replayed or stray deliveries; guests left with no answer |
| Over the hourly limit, a guest is told once and then ignored; at most 5 messages per number wait in line | A flood costing a reply (and memory) per message |
| A daily ceiling on Claude requests for the whole assistant (`CLAUDE_DAILY_CALL_LIMIT`, 3,000 by default); instructions and tools are cached; long tool results aren't kept in memory | Many numbers together, or a bug, running up an unlimited bill |
| Claude requests give up after 30 seconds (one retry) | One stuck request holding up a guest's later messages |
| The console shows only the last four digits of numbers, and names, notes and emails only as a length | Personal details piling up in server logs |
| `GRILL_URL` must be `https://` unless it's this laptop | The booking key being sent unencrypted |
| Reminders only go to numbers in international form, never guessing the country, and never twice on the same day | A South African or British number becoming a stranger's Zimbabwe number, and that stranger getting the guest's manage link |

The Copper Grill site should still enforce its own rules too (how many tables one number may hold,
cancelling after the booking time), store phone numbers in international form (+country code) and verify the
numbers typed on its website form, and accept an idempotency key on new bookings so a retried request can never
book twice.

## Run it on your laptop

You need Node 24 or later, and The Copper Grill site running locally with `ASSISTANT_API_KEY` set in its
`.env.local` (see its `docs/assistant-api.md`).

```bash
npm install
copy .env.example .env      # Windows (use cp on Mac/Linux), then fill in .env
npm run dev
```

Set `TEST_CHAT=1` in `.env` to use the test chat on your laptop, then open http://localhost:4000. It's a test chat that works like WhatsApp. Try:

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
| `npm run reminders` | Sends today's reminders (or lists them if WhatsApp isn't set up). Add a date: `npm run reminders -- 2026-12-05`. Safe to run twice: nobody is reminded twice. Numbers not in international form are listed and skipped |
| `npm run typecheck` | Checks the TypeScript |

## Files

| File | What it is |
| --- | --- |
| `src/prompt.ts` | The assistant's instructions: tone, rules, when to hand over to a person |
| `src/tools.ts` | The actions Claude may take, and the safety checks around them |
| `src/agent.ts` | The loop: send the message to Claude, run any actions, return the reply; short-term memory per guest |
| `src/grill.ts` | The client for the restaurant's booking API |
| `src/whatsapp.ts` | Reading WhatsApp messages and sending replies and reminders |
| `src/guard.ts` | The protections: webhook signatures, local-only test chat, per-number limits, daily budget, capped memory |
| `src/logs.ts` | The accuracy log, with personal details taken out and old files deleted |
| `src/server.ts` | The web server: test chat page and the WhatsApp webhook |
| `src/reminders.ts` | The daily reminder job |
| `public/chat.html` | The test chat page |

## Connecting real WhatsApp (when the restaurant has its number)

1. In Meta for Developers, create an app with WhatsApp, and add the restaurant's WhatsApp Business number.
2. Put the access token, phone number ID and app secret in `.env` (`WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`,
   `WHATSAPP_APP_SECRET`), and choose a random `WHATSAPP_VERIFY_TOKEN`. Set `HOST=0.0.0.0` and leave `TEST_CHAT`
   empty. Set `GRILL_URL` to the site's `https://` address and `PRIVACY_URL` to the restaurant's privacy page.
3. Deploy the assistant somewhere with a public HTTPS address, and set the webhook URL to
   `https://<that address>/webhook` with the same verify token. Subscribe to `messages`.
4. For reminders, create a **utility** message template named `booking_reminder` with four variables, for
   example: *"Hi {{1}}, a reminder of your table for {{2}} at The Copper Grill today at {{3}}. View or cancel:
   {{4}}"*. WhatsApp only allows business-started messages through approved templates. Then schedule
   `npm run reminders` each morning.

Check Meta's current Graph API version and per-message prices for Zimbabwe before going live. Also set a monthly
spending limit for the API key in the Anthropic Console, as a second ceiling behind `CLAUDE_DAILY_CALL_LIMIT`.

## Known limits (first version)

- Conversation memory is kept in the running process, so a restart forgets open chats (bookings are safe in
  the database). The limits are also per process, so run one copy of the assistant.
- Text messages only; voice notes are planned.
- Shona and Ndebele replies depend on the model's ability in those languages and need testing with real guests.
