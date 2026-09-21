# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

iBIT (Identifying Barriers to Investment Tool) is a WhatsApp chatbot that interviews South African business owners/investors about policy, legal and regulatory barriers to investment, then hands them off to a WhatsApp Flow form for structured survey data. It is a single Express server receiving Meta Cloud API webhooks — no build step, no test suite, no framework beyond Express.

## Commands

```bash
npm install
npm start          # node main.js — starts the webhook server on PORT (default 3000)
node cleanup.js    # one-shot job: migrate expired conversations to the long-term DB, then exit
```

`cleanup.js` calls `cleanup()` at the bottom of the file and is intended to be run by an external scheduler (cron), not from the server process.

Voice notes require the `ffmpeg` binary on PATH (`openai_functions.js` shells out via `execSync` to transcode WhatsApp `.ogg` → `.wav` before Whisper).

Env vars (via `dotenv`, plus gitignored `config.bat` for local Windows shells): `DATABASE_URL`, `LONG_TERM_DB_URL`, `VERIFY_TOKEN`, `WHATSAPP_TOKEN`, `PHONE_NUMBER_ID`, `BOT_PHONE_NUMBER`, `OPENAI_API_KEY`, `GCP_PROJECT_ID`, `GCP_TRANSLATE_LOCATION`, `GOOGLE_CREDENTIALS` (service-account JSON as a string), `PORT`.

## Architecture

**Two Postgres databases, deliberately separated** (`db.js` exports `query` and `longTermQuery`):
- Short-term DB — live PII: `user_terms`, `conversations`, `messages`. `user_terms` and `conversations` carry `expired_at` on a sliding 24h window from the user's **last** inbound message (matching WhatsApp's customer-service window): `getOrCreateConversation` pushes both out by 24h on every inbound message. A conversation or terms record already past `expired_at` is treated as over even before cleanup collects it — the user gets a new conversation and has to accept the terms again.
- Long-term DB — de-identified research data: a single `survey_responses` table.

`cleanup.js` is the bridge and the privacy boundary. It deletes expired `user_terms` rows on their own (they never take a conversation with them), then handles each expired conversation separately. Only conversations with `terms_accepted = true` **and** a submitted Flow (`first_message`) are migrated — the rest (no consent, or no survey data) are hard-deleted without touching the research DB. For each migrated conversation it: hashes the phone number (SHA-256) into `user_id`, buckets `started_at` to the preceding Monday (`getMonday`) so exact timing is lost, redacts PII from every message with `removePII` (regex for emails/phones/GPS/SA ID numbers/street addresses + `compromise` NER for people, places and orgs — "South Africa"/"Africa" are deliberately preserved), flattens the Flow form answers via `parseFirstMessage`, inserts into `survey_responses`, then hard-deletes the short-term rows. Any change to conversation storage must keep this path working, or PII leaks into the research DB.

**The conversation state machine** lives in the `switch (conversation.state)` in `main.js`'s `POST /webhook`. States: `active` → `structured` → `unstructured` → `finish`. The Flow form comes *before* the interview, so every conversation that gets past the terms carries structured data.
- `active` — terms of use not yet accepted. The user's first message is buffered into `conversations.data`, then the terms message goes out as two quick-reply buttons (`continue_terms` / `quit_terms`). Accepting sends the Flow (`sendSurveyFlow`) and moves to `structured` — the buffered message is *not* answered yet. Returning users with `user_terms.terms_accepted = true` are fast-forwarded past this case near the top of the handler: their first message is buffered and they get the Flow straight away, on every new conversation.
- `structured` — the survey Flow stage. An `interactive.nfm_reply` (Flow submission) stores its JSON in `conversations.first_message` (minus `flow_token`), moves state to `unstructured`, and then `runAiTurn` answers the buffered first message. Any other message re-sends the Flow with `prompts.flow_nudge_message`, in the language of *that* message (which is also stored, so a misdetected first message can't lock the language); once `prompts.flow_send_limit` Flows have gone out (counted from `messages` rows of type `flow`) the conversation is closed.
- `unstructured` — free-form AI interview, and the closing stage. Ends when the model returns `type: "location_request"` (its text is sent as plain text) or when the user message count hits `prompts.message_limt` (`prompts.interview_complete_message` is sent); either way state becomes `finish` with `expired_at = NOW()`, which makes `cleanup.js` pick it up on its next run. `"location_request"` is a legacy name for the AI contract — it now means "interview finished", not "send the Flow".
- Typing `quit` at any point immediately deletes the user's `user_terms`, `messages` and `conversation` rows.

The webhook `res.sendStatus(200)` fires before any processing — Meta must not be kept waiting, and failures are logged, never retried.

**Conversation history is stored twice**, as parallel JSON arrays on the `conversations` row:
- `data` — English, what actually goes to the model.
- `data_translated` — the user's own language, for the human record.

The system prompt is never persisted; it is appended to `data` only when building the OpenAI request. User turns are wrapped in `±` markers on the way in — the prompt in `prompts.js` tells the model that is the input delimiter, so don't drop them.

**Translation** (`translate.js`, Google Cloud Translation v3): `detectAndTranslate` returns `shouldUseEnglish`, which is the flag the rest of the code branches on rather than the raw language code. Short messages (≤2 words) matching `SHORT_GREETING_CATCHES` — after stripping punctuation and collapsing repeated letters, with a one-letter typo allowance for words of 4+ letters ("hellow", "hellooo") — short-circuit to English and are rewritten to `"Hello"` so a one-word greeting can't misdetect the whole conversation's language. Outbound AI text is translated back with `translateToSelectedLanguage` when the stored language isn't `en`.

**AI contract** (`openai_functions.js` + `prompts.js`): the model must return `{"text": ..., "type": "location_request" | "-"}`. `getResponses` returns a parsed object, not a string — it strips code fences and extracts the first `{...}` block on a parse failure, falling back to `{ text: rawContent, type: "-" }`. `"-"` means send as plain text; `"location_request"` means the interview is over — send the text and close the conversation. Model, temperature and token limits live in `prompts.model_params`; the Flow ID and CTA in `prompts.flow_params`.

**Outbound messaging** (`messages.js`) — every sender posts to `graph.facebook.com/v21.0/{PHONE_NUMBER_ID}/messages` and then logs the returned `wamid` into `messages`, so the DB mirrors what WhatsApp actually accepted. Senders swallow their errors and return `undefined`; callers do not check. `sendMenu`, `sendPDF` and `sendURLButton` are marked `TODO need editing` and are not wired into the flow.

`structured_data.json` is the WhatsApp Flow definition (screens + fields) uploaded to Meta's Flow Builder — no code reads it. Its field names are the contract `parseFirstMessage` in `cleanup.js` parses, so the two must be changed together.

## Conventions

- CommonJS, Node ≥18, no transpilation, no linter config.
- User-facing copy, the system prompt, model params and the Flow ID all live in `prompts.js` — change wording there, not inline in `main.js`.
- Log lines use emoji prefixes (📩 inbound, 🤖 AI, ✅ success, ❌ error). Debug logs are commented out rather than deleted throughout `main.js`.
