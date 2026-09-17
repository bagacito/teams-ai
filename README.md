# teams-ai-assistant

A self-hosted Node.js service that watches selected Microsoft Teams chats
(bridged by **Power Automate**) and drafts suggested replies with an internal
OpenAI-compatible AI API (PDM.AI). **Nothing is ever sent to Teams
automatically** — every AI reply is stored as a pending draft that you must
explicitly approve, edit, or reject in the web UI.

```
Microsoft Teams
  → Power Automate flow (inbound)      you build this flow
  → HTTPS POST /api/power-automate/inbound
  → validate shared secret + payload
  → allowlist (allowed sender OR allowed group chat)
  → load context / history / style
  → generate draft with PDM.AI
  → store as pending + ntfy notification        ← STOPS HERE
  → you approve/edit/reject in the web UI
  → app calls Power Automate flow (outbound)    ← only after approval
  → flow posts the reply to Microsoft Teams
```

## Core safety rule

> NO AI-GENERATED MESSAGE MAY BE SENT TO TEAMS WITHOUT EXPLICIT HUMAN APPROVAL.

Enforced structurally, not by prompt instructions:

- `src/ai/*` and the ingestion pipeline (`src/pipeline/ingest.js`) produce
  **reply text only** and store it as a `pending` draft. They contain no
  reference to any outbound sender.
- `src/integrations/power-automate/outbound.js` (the only Teams-sending
  module) is wired **exclusively** into the approval flow
  (`src/routes/drafts.js` → `sendApprovedDraft`).
- A static test (`test/safety.test.mjs`) fails the build if any other module
  imports the outbound sender, or if the pipeline ever receives one.
- The outbound flow itself is only called with a `requestId` fixed at claim
  time; double-clicks and retries cannot send twice.

## Architecture

| Path | Purpose |
| --- | --- |
| `src/integrations/power-automate/inbound.js` | Authenticated `POST /api/power-automate/inbound` endpoint |
| `src/integrations/power-automate/schemas.js` | Zod schemas: inbound payload, outbound payload, response contract |
| `src/integrations/power-automate/signature.js` | Timing-safe Bearer secret verification |
| `src/integrations/power-automate/outbound.js` | Calls the outbound flow (timeout, idempotency, dryRun test) |
| `src/pipeline/ingest.js` | Dedupe → allowlist → save message → `shouldDraft()` → PDM.AI → pending draft |
| `src/ai/client.js` | Reusable OpenAI-compatible client (custom baseURL/model) |
| `src/ai/draft.js`, `prompt.js`, `style.js` | Prompt assembly and draft generation |
| `src/policy/allowlist.js` | Allowed user / allowed chat rules (isolated) |
| `src/policy/should-draft.js` | Response-worthiness heuristics (isolated, AI-classifiable later) |
| `src/context/*` | Capped recent history, factual conversation summaries, chat context |
| `src/notifications/*` | Provider abstraction; ntfy implemented (minimal/full detail) |
| `src/db/*` | better-sqlite3 schema, migrations, repositories |
| `src/routes/*` + `src/views/layout.js` | Fastify server-rendered admin/approval UI, sessions, CSRF |

## First run: quick start

Complete setup in this order. Variables marked **required** must be filled
before the app is useful.

### 1. Fill `.env`

```bash
cp .env.example .env
```

| Variable | Required | What to put in it |
| --- | --- | --- |
| `ADMIN_PASSWORD` | **yes** | Long random passphrase, **min 16 chars** (e.g. `openssl rand -base64 24`). Read once on first boot, then hashed into the DB. |
| `PDM_AI_API_KEY` | **yes** | API key for the internal AI router. |
| `PDM_AI_BASE_URL` | pre-filled | `https://router.ai.pdmfc.com/v1` — keep unless your router differs. |
| `PDM_AI_MODEL` | pre-filled | `DeepSeek-V4.1-Flash` — keep unless told otherwise. |
| `POWER_AUTOMATE_INBOUND_SECRET` | **yes** | Long random string (e.g. `openssl rand -hex 32`). Paste the **same value** into your inbound Power Automate flow (step 3). |
| `POWER_AUTOMATE_OUTBOUND_URL` | yes, at step 4 | URL of your "send reply" Power Automate flow (created in step 4). |
| `POWER_AUTOMATE_OUTBOUND_SECRET` | yes, at step 4 | Long random string shared with the outbound flow. |
| `PUBLIC_BASE_URL` | **yes** | Public HTTPS URL of this server (e.g. `https://teams-ai.example.com`). Needed for webhook links, notification deep-links, and secure cookies. |
| `NTFY_URL` / `NTFY_TOPIC` / `NTFY_TOKEN` | optional | ntfy server + hard-to-guess topic (+ token if protected). Leave empty to skip notifications. |
| `NTFY_DETAIL_MODE` | optional | `minimal` (default) or `full`. |
| `RECENT_MESSAGE_COUNT` | optional | Recent messages fed to the AI (default 20). |
| `DRAFT_EXPIRY_HOURS` | optional | Hours before pending drafts expire (default 12). |
| `PORT` / `LOG_LEVEL` / `DATA_DIR` | optional | Defaults: 3000 / info / ./data. |

Generate the secrets now and keep them handy — both flows need them:

```bash
openssl rand -hex 32   # POWER_AUTOMATE_INBOUND_SECRET
openssl rand -hex 32   # POWER_AUTOMATE_OUTBOUND_SECRET
openssl rand -base64 24  # ADMIN_PASSWORD
```

### 2. Start the app

```bash
docker compose up -d --build
docker compose logs -f          # confirm: "teams-ai-assistant started"
curl https://YOUR-DOMAIN/health # should return {"status":"ok"}
```

Open `https://YOUR-DOMAIN` (redirects to `/login`), sign in with
`ADMIN_PASSWORD`. You only need this password once — it is hashed at rest
afterwards and can be removed from `.env`.

### 3. Create the inbound Power Automate flow (Teams → app)

Follow the full guide below ("Power Automate inbound flow"). In short:

1. Trigger on new Teams chat messages for the chats you want watched.
2. HTTP POST action → `https://YOUR-DOMAIN/api/power-automate/inbound`
   with headers `Content-Type: application/json` and
   `Authorization: Bearer <POWER_AUTOMATE_INBOUND_SECRET>`.
3. Body: the JSON payload documented on the `/integrations` page
   (also shown in the full guide below).

### 4. Create the outbound Power Automate flow (app → Teams)

Follow the guide below ("Power Automate outbound flow"). In short:

1. Instant HTTP-trigger flow ("When an HTTP request is received") that posts
   `messageText` to the Teams chat given in `chatId` and responds
   `{"success": true, "teamsMessageId": "..."}`.
2. Copy the flow URL into `.env` as `POWER_AUTOMATE_OUTBOUND_URL`, set
   `POWER_AUTOMATE_OUTBOUND_SECRET`, then:

```bash
docker compose up -d   # restart to pick up the new variables
```

3. Verify on the `/integrations` page: everything shows **configured**, then
   click **Test outbound connection** (non-destructive `dryRun` — no Teams
   message is posted).

### 5. First message test

1. In the web UI → `/users`: add yourself (Teams user ID or email) — or add
   a test chat under `/chats` with the exact `chatId` your flow sends.
2. From that account, post a message that needs a response (e.g.
   "Can you test the draft flow?").
3. Within seconds: ntfy notification (if configured) and a pending draft on
   `/drafts` showing sender, chat, original message, AI reply.
4. Try **Approve & Send** on a harmless chat — the reply should appear in
   Teams. Then try **Edit → Save & Send**, and **Reject** on another.
5. Check `/style` — the approved/edited final text now appears as a style
   example; rejected text never does.

### 6. Day-to-day

- Approve/edit/reject drafts on `/drafts` (mobile-friendly).
- Tune per-chat context on `/chats`, global context on `/settings`.
- Add colleagues to `/users` or whole group chats to `/chats`.
- Integration health anytime on `/integrations`.
- If sends fail (flow moved/renamed), the draft becomes `failed` with a
  **Retry** button once the flow works again.

## Prerequisites

- Node.js ≥ 22 (or Docker + Docker Compose on Ubuntu)
- A Power Automate license that allows the flows below (trigger/action names
  vary by tenant and license — adapt as needed)
- Access to the internal AI router (`PDM_AI_BASE_URL` + API key)
- Optional: an ntfy server for push notifications
- A publicly reachable HTTPS URL for the inbound endpoint

## Docker deployment (Ubuntu)

```bash
git clone <this repo> && cd teams-ai
cp .env.example .env
# edit .env:
#   PDM_AI_API_KEY, ADMIN_PASSWORD (min 16 chars),
#   POWER_AUTOMATE_INBOUND_SECRET  (long random string),
#   POWER_AUTOMATE_OUTBOUND_URL + POWER_AUTOMATE_OUTBOUND_SECRET (after step 2),
#   PUBLIC_BASE_URL, NTFY_* (optional)
docker compose up -d --build
docker compose logs -f
```

Data (SQLite database) persists in `./data` mounted at `/app/data`. The
container runs as non-root, exposes port 3000, and has a healthcheck on
`/health`. No Microsoft credentials live inside the container — only the two
shared secrets and the PDM.AI key.

## Power Automate inbound flow (Teams → app)

Create a flow that forwards every new Teams chat message to this app.
Exact trigger and connector action names vary by tenant/license — the shape
below is what matters.

**Trigger:** a Microsoft Teams "new chat/channel message" trigger appropriate
for your environment (e.g. a Teams trigger for messages in selected chats, or
a polling trigger over messages). Configure it for the chats you want watched.

**Actions:**

1. **Extract** from the trigger output:
   - a unique event ID (e.g. the flow run's ID or a message-ID-based value)
   - the Teams message ID
   - the chat/conversation ID (stable id, e.g. `19:...@thread.v2`)
   - chat name if available
   - sender ID (stable Microsoft user id or email)
   - sender display name
   - sender email if available
   - message text (plain text)
   - message timestamp
   - reply-to message ID if available
   - whether you were mentioned, if available

2. **Normalize into this JSON** (compose/Parse JSON action):

```json
{
  "eventId": "unique-event-id",
  "messageId": "teams-message-id",
  "chatId": "teams-chat-id",
  "chatName": "friendly chat name",
  "senderId": "microsoft-user-id-or-email",
  "senderName": "display name",
  "senderEmail": "user@company.com",
  "messageText": "message contents",
  "messageType": "message",
  "timestamp": "2026-09-17T15:00:00Z",
  "replyToMessageId": null,
  "mentionedMe": false
}
```

3. **HTTP POST** to `${PUBLIC_BASE_URL}/api/power-automate/inbound`:
   - `Content-Type: application/json`
   - `Authorization: Bearer <POWER_AUTOMATE_INBOUND_SECRET>`

4. **Treat HTTP 200 as accepted** even when the response says the message was
   intentionally ignored (unallowed sender/chat, "thanks", reactions,
   duplicates, your own messages). `400` = malformed payload (fix the flow's
   JSON), `401` = wrong secret.

The app deduplicates on both `eventId` (retries) and `messageId` (double
delivery) and answers 200 for duplicates — safe to retry.

## Power Automate outbound flow (app → Teams)

Create a second flow that posts the approved reply.

1. **Trigger:** *When an HTTP request is received* (instant HTTP trigger).
   Note the generated URL → `POWER_AUTOMATE_OUTBOUND_URL`.
2. **Validate the shared secret** in the request body/header. If your flow
   platform cannot check an Authorization header, the safest alternative is
   to include the secret as a required body property and have the flow
   compare it against configured content before doing anything (terminate
   with a non-2xx response otherwise). This app sends the secret as
   `Authorization: Bearer <POWER_AUTOMATE_OUTBOUND_SECRET>`; add a *Compose*
   + *Condition* step checking `triggerHeaders()['Authorization']` equals
   `Bearer <secret>` where supported.
3. **Request body fields:** `requestId`, `draftId`, `chatId`,
   `replyToMessageId`, `messageText` (and `dryRun: true` for connectivity
   tests).
4. **If `dryRun` is true:** respond `{"success": true}` immediately without
   posting anything (used by the /integrations connectivity test).
5. **Post `messageText` to the Teams chat** identified by `chatId` (use a
   Teams "post message in a chat" action).
6. **If possible, reply to the original message** when `replyToMessageId` is
   present (reply-in-thread action); otherwise post a normal message.
7. **Respond** to the HTTP call:
   - success: `{"success": true, "teamsMessageId": "<sent message id>"}`
   - failure: non-2xx response, or `{"success": false, "error": "<safe message>"}`

**Idempotency:** track processed `requestId` values (e.g. persist them to a
SharePoint list/Excel/DataVerse row and check before posting). If the app
retries (Retry button after an ambiguous timeout), the same `requestId`
arrives — skip posting and return the original result. The app marks a draft
`failed` on failure and offers Retry; it never auto-retries after an
ambiguous timeout.

## Approving / editing / rejecting replies (/drafts)

- **Approve & Send** — the exact AI text goes through the outbound flow,
  the draft is marked `sent`, recorded as your message, and becomes an
  `approved_draft` style example.
- **Edit** — modify the text and *Save & Send*; the edited text is what
  Teams receives and becomes an `edited_draft` (higher-quality) example.
- **Reject** — marked rejected; can never be sent or used for style.
- **Retry** — for `failed` sends (outbound error/timeout).
- **Regenerate** — for `expired` drafts (`DRAFT_EXPIRY_HOURS`, default 12):
  creates a fresh pending draft using current conversation state.
- Double-clicks cannot double-send: the `sending` state transition is atomic.

## Adding approved people (/users)

- Stable identifier (Microsoft user ID or email) + label.
- Messages from these people are eligible wherever they write.
- Enable/disable or remove at any time.

## Adding approved group chats (/chats)

- Add the chat ID (e.g. `19:abc123@thread.v2`) exactly as your inbound flow
  sends it in `chatId`, plus a friendly name.
- Any message in an enabled chat is eligible **regardless of participant**.
- The **context** field is free text passed to the AI on every draft.

**Authorization rule (v1):** a message is eligible if the *sender* is an
enabled allowed user **OR** the *chat* is an enabled allowed chat. The rule
lives in one small function in `src/policy/allowlist.js`.

## Conversation context and summaries

- Per-chat context: `/chats`. Global context: `/settings`.
- Recent history fed to the AI is capped (`RECENT_MESSAGE_COUNT`, default 20).
- Once a chat exceeds `SUMMARY_TRIGGER_MESSAGE_COUNT` (default 40) stored
  messages, a factual summary is generated (decisions, open questions,
  owners, dates, project state, terminology). Writing style is **never**
  mixed into summaries; style lives only in style examples.

## Managing writing-style examples (/style)

| Source | Meaning |
| --- | --- |
| `manual` | You typed it on /style |
| `teams` | Messages you sent yourself (substantive ones captured automatically) |
| `approved_draft` | A draft you approved **unchanged** and was sent |
| `edited_draft` | A draft you edited — the edited text you sent |

- Rejected drafts are never used; an AI draft never becomes an example by
  itself; nothing is silently rewritten.
- Examples can be enabled/disabled/deleted.
- Set *My Teams user ID / email* in `/settings` so the app recognizes your
  own messages (ignored for drafting, captured for style).

## Setting up ntfy

1. Self-host ntfy or use `https://ntfy.sh`; choose a hard-to-guess topic.
2. `NTFY_TOPIC` (+ `NTFY_TOKEN` if protected).
3. `NTFY_DETAIL_MODE`: `minimal` (default: "New Teams reply waiting for
   approval - Alice - Project Alpha") or `full` (includes message + draft).
4. Notifications deep-link to `/drafts`.

## Integrations status (/integrations)

Shows configured/not-configured for Power Automate inbound (secret set),
Power Automate outbound (URL + secret set), and PDM.AI — without displaying
secret values. Also shows the exact inbound URL + required headers, a sample
payload, and a non-destructive **Test outbound connection** button (sends
`dryRun: true`; the flow must not post a Teams message for dry runs).

## Testing draft generation

1. Add an allowed user or allowed chat; ensure your inbound flow covers it.
2. From an allowed account, post a message that needs a response.
3. A notification arrives; `/drafts` shows sender, chat, time, original
   message, AI reply.
4. Logs show `power automate inbound request received`, `draft generated`,
   and `message ignored + reason` for skipped ones (reactions, "ok"/"thanks",
   own messages, duplicates, non-allowed, system types).

## Security

- Admin UI behind session auth; password hashed (scrypt) at rest on first
  boot from `ADMIN_PASSWORD` (min 16 chars).
- Secure/HttpOnly/SameSite cookies (secure when `PUBLIC_BASE_URL` is https);
  login rate-limited (5/min).
- CSRF tokens on all state-changing forms; Zod validation on all inputs
  (including the inbound payload); HTML-escaped rendering; helmet CSP.
- Inbound endpoint: timing-safe Bearer secret comparison; 401 on bad secret;
  generous rate limit (240/min) so legitimate Power Automate retries pass.
- Never logged: shared secrets, Authorization headers, API keys
  (pino redaction + structured logs only). Full Teams conversation contents
  are not logged by default.
- Put the service behind HTTPS; don't expose port 3000 raw.

## Configuration reference

See `.env.example`.

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP port (3000) |
| `PUBLIC_BASE_URL` | Public HTTPS URL (inbound URL shown in UI, notification links, secure cookies) |
| `PDM_AI_BASE_URL` / `PDM_AI_API_KEY` / `PDM_AI_MODEL` | Internal AI router (default `DeepSeek-V4.1-Flash`, temperature 0.2) |
| `POWER_AUTOMATE_INBOUND_SECRET` | Shared secret for inbound POSTs (`Authorization: Bearer ...`) |
| `POWER_AUTOMATE_OUTBOUND_URL` | HTTP-trigger flow URL for approved replies |
| `POWER_AUTOMATE_OUTBOUND_SECRET` | Shared secret sent to the outbound flow |
| `ADMIN_PASSWORD` | Initial admin password (min 16 chars, hashed at rest) |
| `NTFY_URL` / `NTFY_TOPIC` / `NTFY_TOKEN` / `NTFY_DETAIL_MODE` | Push notifications |
| `RECENT_MESSAGE_COUNT` | Recent messages fed as context (default 20) |
| `SUMMARY_TRIGGER_MESSAGE_COUNT` | Chat size before a summary is generated (default 40) |
| `DRAFT_EXPIRY_HOURS` | Pending draft expiry (default 12) |
| `LOG_LEVEL` | pino level |
| `DATA_DIR` | Persistent data directory (`/app/data` in Docker) |

## Tests

```bash
npm test
```

Covers: inbound auth (valid/invalid/missing secret), malformed payloads,
duplicate eventId/messageId, allowlist (sender, group chat, unapproved),
own-message detection (id or email), system/reaction filtering, the
send-only-after-approval boundary (including a static import scan), single
outbound call on approval, double-approval protection, edited-text sending,
outbound failure → failed + Retry, Teams message ID persistence, style
learning rules, prompt assembly/context capping, and ntfy privacy modes.
PDM.AI and the outbound flow are fully mocked.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `401` in the flow | Secret mismatch: compare `POWER_AUTOMATE_INBOUND_SECRET` with the flow's Authorization header |
| `400` in the flow | Payload shape wrong — compare with the sample on `/integrations` |
| Drafts never appear | Check allowlists (`/users`, `/chats`); check logs for `message ignored + reason`; ensure the flow actually fires for those chats |
| Duplicate drafts for one message | Should not happen (eventId + messageId dedupe); check `processed_events`/`messages` tables |
| Approve fails instantly | `POWER_AUTOMATE_OUTBOUND_URL`/`SECRET` unset or wrong — check `/integrations`, use *Test outbound connection* |
| Send marked failed with timeout | The flow may still have posted; use Retry only after checking Teams — the shared `requestId` lets an idempotent flow dedupe |
| No notifications | Verify `NTFY_URL`/`NTFY_TOPIC`, subscribe in the ntfy app, check logs for `notification failed` |
| `ADMIN_PASSWORD` error at boot | Must be ≥ 16 chars; only read the first time (hashed afterwards) |
| Outbound page shows "not configured" | Set both outbound env vars and restart the container |
