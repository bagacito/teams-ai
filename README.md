# teams-ai-assistant

A self-hosted Node.js service that watches selected Microsoft Teams chats and
drafts suggested replies with an internal OpenAI-compatible AI API
(PDM.AI). **Nothing is ever sent to Teams automatically** — every AI reply is
stored as a pending draft that you must explicitly approve, edit, or reject
in the web UI.

## Core safety rule

> NO AI-GENERATED MESSAGE MAY BE SENT TO TEAMS WITHOUT EXPLICIT HUMAN APPROVAL.

Enforced structurally:

- `src/ai/*` and the webhook ingestion pipeline produce **reply text only** and
  store it as a `pending` draft row. They contain no reference to the send
  function.
- `src/teams/send.js` (the only Teams-sending module) is wired **exclusively**
  into the approval flow (`src/routes/drafts.js` → `sendApprovedDraft`).
- A static test (`test/safety.test.mjs`) fails the build if any other module
  imports the send module, or if the pipeline ever receives a send reference.

## Architecture

```
Teams (Graph change notifications)
        │  POST /webhook  (validation-token challenge handled)
        ▼
src/teams/webhook.js          validate → dedupe → allowlist → save message
        │                     → shouldDraft() → build context → PDM.AI
        ▼
drafts table (status: pending) + ntfy push notification     ← STOPS HERE

Human (web UI /drafts) ── Approve & Send ──▶ routes/drafts.js
        │                                    │ atomic claim (pending|edited → sending)
        │                                    ▼
        │                          src/teams/send.js → Graph sendChatMessage
        │                                    │ success: mark sent, store as my
        │                                    │ message, optionally style example
        ▼                                    ▼ failure: mark failed + Retry
Edit / Reject / Regenerate / expiration worker
```

Key modules:

| Path | Purpose |
| --- | --- |
| `src/ai/client.js` | Reusable OpenAI-compatible client (PDM.AI router, custom baseURL/model) |
| `src/ai/draft.js`, `prompt.js`, `style.js` | Prompt assembly (behavior + style + examples + context) and draft generation |
| `src/teams/auth.js` | MSAL device-code delegated auth, token cache persisted in `/app/data` |
| `src/teams/graph.js` | Graph REST client |
| `src/teams/send.js` | **Only** Teams send path (approval flow only) |
| `src/teams/subscriptions.js` | Graph subscription create/renew/recreate |
| `src/teams/webhook.js` | Change-notification validation + ingestion pipeline |
| `src/policy/allowlist.js` | Allowed user / allowed chat rules (isolated, easy to change) |
| `src/policy/should-draft.js` | Response-worthiness heuristics (isolated, replaceable by AI later) |
| `src/context/*` | Recent history (capped), factual conversation summaries, chat context |
| `src/notifications/*` | Provider abstraction; ntfy implemented (minimal/full detail) |
| `src/db/*` | better-sqlite3 schema, migrations, repositories |
| `src/routes/*` + `src/views/layout.js` | Fastify server-rendered admin/approval UI, sessions, CSRF |

## Prerequisites

- Node.js ≥ 22 (or Docker + Docker Compose on Ubuntu)
- A Microsoft Entra ID application registration (see below)
- Access to the internal AI router (`PDM_AI_BASE_URL` + API key)
- Optional: an ntfy server for push notifications
- A publicly reachable HTTPS URL for Graph webhooks (see *Webhook URL
  requirements*)

## Microsoft Entra app registration

1. Azure Portal → **Microsoft Entra ID** → **App registrations** → **New registration**.
2. Name: e.g. `teams-ai-assistant`. Supported account type: **Single tenant**
   (or as appropriate for your org).
3. No redirect URI is needed for device code flow, but it does no harm to add
   **Mobile and desktop applications** → `https://login.microsoftonline.com/common/oauth2/nativeclient`.
4. Note the **Application (client) ID** → `MS_CLIENT_ID`, and your tenant ID
   (Overview → Directory ID) → `MS_TENANT_ID`.
5. **API permissions** → **Add a permission** → **Microsoft Graph** →
   **Delegated permissions**:

   | Permission | Why |
   | --- | --- |
   | `Chat.ReadWrite` | Read chats/messages in allowed chats, receive change notifications |
   | `ChatMessage.Send` | Send a Teams message as the authenticated user (approval flow only) |
   | `User.Read` | Identify the authenticated user (ignore own messages, tag sent ones) |
   | `offline_access` | Refresh tokens so authentication survives restarts |

   For subscriptions to another user's messages with delegated auth, your
   tenant may additionally require admin-approved `Chat.ReadWrite` and
   `ChatMessage.Read` — ask your admin to grant admin consent.
6. Click **Grant admin consent** if your tenant requires it.
7. Client secrets are **not** needed — this app uses delegated device-code
   authentication only.

## Device-code authentication

The first login is interactive:

```bash
docker compose exec teams-ai-assistant npm run auth
# or locally: npm run auth
```

The console prints `https://microsoft.com/devicelogin` plus a short code.
Open it on any device, sign in with the account that should "own" the replies
(this is *you* — messages sent by this user are treated as *your* messages).
The MSAL token cache is stored at `/app/data/msal-cache.json` (0600
permissions), so authentication survives container restarts. Refresh is
silent afterwards. Tokens are never logged.

## Webhook URL requirements

- Graph must reach `PUBLIC_BASE_URL/webhook` over **HTTPS** with a valid
  certificate (port 443). Use a reverse proxy (Caddy/nginx/traefik) in front
  of the container, or a tunnel (cloudflared, ngrok for testing).
- On subscription creation Graph sends a `GET /webhook?validationToken=...`
  challenge; the app echoes the token as `text/plain` automatically.
- Set `PUBLIC_BASE_URL=https://your-domain.example` — it is used for the
  challenge response, notification `click` URLs, and cookie security flags.

## Docker deployment (Ubuntu)

```bash
git clone <this repo> && cd teams-ai
cp .env.example .env
# edit .env: PDM_AI_API_KEY, MS_TENANT_ID, MS_CLIENT_ID, PUBLIC_BASE_URL,
#           ADMIN_PASSWORD (min 16 chars), NTFY_* (optional)
docker compose up -d --build
docker compose logs -f
# first login:
docker compose exec teams-ai-assistant npm run auth
```

Data (SQLite database + MSAL cache) persists in `./data` mounted at
`/app/data`. The container runs as non-root and exposes port 3000 with a
healthcheck on `/health`.

## Adding approved people (/users)

- Entra user ID (GUID) + label. Find the GUID in Entra under the user's
  profile, or via `https://graph.microsoft.com/v1.0/users/<upn>` (`id` field).
- Messages from these people are eligible wherever they write (1:1 or group).
- Enable/disable or remove at any time.

## Adding approved group chats (/chats)

- Get the chat ID via Graph: `GET /chats?$select=id,topic` (or from the
  address of a chat in Graph Explorer). Looks like `19:abc123@thread.v2`.
- Any message in an enabled chat is eligible **regardless of participant**.
- The **context** field is free text attached to the chat and passed to the
  AI on every draft (project background, people, rules of engagement).
- Adding a chat automatically attempts to create a Graph subscription.

**Authorization rule (v1):** a message is eligible if the *sender* is an
enabled allowed user **OR** the *chat* is an enabled allowed chat. The rule
lives in `src/policy/allowlist.js` in one small function — change it there.

## Adding conversation context

- Per chat: `/chats` → context textarea.
- Global: `/settings` → *Global context about you* (applies to every draft).
- Context is instructions, not history — keep it factual and short.

## Managing writing-style examples (/style)

The AI imitates **your** writing. Style comes from `style_examples`, sourced:

| Source | Meaning |
| --- | --- |
| `manual` | You typed it on /style |
| `teams` | Reserved for messages you sent yourself |
| `approved_draft` | A draft you approved **unchanged** and was sent |
| `edited_draft` | A draft you edited — the edited text you sent |

Rules:

- Rejected drafts are **never** used.
- An AI draft never becomes an example by itself; only the final human-approved text.
- Examples can be enabled/disabled/deleted; nothing is silently rewritten.
- When you send a Teams message yourself, substantive ones (≥15 chars) are
  automatically kept as `teams` style candidates (disable via the
  `capture_own_messages_style` setting in the database, default on).
- The style instructions in `src/ai/prompt.js` tell the model to preserve your
  vocabulary, length, capitalization, directness, abbreviations, tone and
  formatting — and to only fix spelling/obvious grammar.

## Setting up ntfy

1. Self-host ntfy or use `https://ntfy.sh`.
2. Choose a hard-to-guess topic (it is effectively a password) and set
   `NTFY_TOPIC`. If the topic is protected, also set `NTFY_TOKEN`.
3. `NTFY_DETAIL_MODE`:
   - `minimal` (default): `New Teams reply waiting for approval - Alice - Project Alpha`
   - `full`: includes the original message and the suggested reply.
4. Notifications deep-link to `/drafts` via the `Click` header.

Test: install the ntfy app, subscribe to your topic, then approve yourself a
message or use the test instructions below.

## Subscriptions: creation, renewal (/subscriptions)

- Subscriptions watch `/chats/{id}/messages` for `created` events and expire
  in under an hour. The app stores subscription id + expiration.
- A background worker renews every due subscription before expiry; if renewal
  fails it deletes and **recreates** the subscription, logging the error.
- `/subscriptions` shows health (status, expiry, last renew, last error) with
  manual **Renew**, **Recreate**, **Renew due now**, and **Create missing**.

## Testing draft generation

1. Add yourself as an allowed user (or your test chat under /chats).
2. From an allowed account, post a message that needs a response
   (a question, request, or a mention of you).
3. Within seconds a notification should arrive and `/drafts` shows a pending
   draft card: sender, chat, time, original message, AI reply.
4. `docker compose logs -f` shows `message received`, `draft generated`, and
   ignore reasons for skipped messages (`message ignored + reason`).

Messages that never create drafts: reactions, emoji-only, GIFs, "ok",
"thanks", greetings, system messages, your own messages, duplicates,
non-allowed senders/chats. All are still logged with a reason.

## Approving / editing / rejecting replies

- **Approve & Send** — the exact AI text is sent to Teams, marked `sent`,
  recorded as your message, and becomes an `approved_draft` style example.
- **Edit** — modify the text and *Save & Send*; the edited text is what Teams
  receives and becomes an `edited_draft` (higher-quality) style example.
- **Reject** — the draft is marked rejected and can never be sent or used for style.
- Double-clicks cannot double-send: the `sending` state transition is atomic.
- If Graph rejects the send, the draft becomes `failed` with safe error
  details and a **Retry** action.
- Pending drafts expire after `DRAFT_EXPIRY_HOURS` (default 12) via the
  background worker. Expired drafts can only be **Regenerated** (with current
  conversation state) — never sent as-is.

## Security considerations

- The admin UI requires a session; the password is set once from
  `ADMIN_PASSWORD` and stored **hashed** (scrypt) in the database — the env
  value can be removed afterwards.
- Sessions use secure, HttpOnly, SameSite=Lax cookies (secure flag when
  `PUBLIC_BASE_URL` is https). Login is rate-limited (5/min).
- Every state-changing form POST is CSRF-protected with rotating per-session
  tokens.
- All request input is validated with Zod; all rendered user content is
  HTML-escaped; CSP is set via helmet.
- Never logged: API keys, access/refresh tokens, authorization headers,
  cookies (pino redact + MSAL logging disabled). Full conversation contents
  are not logged by default.
- Put the service behind HTTPS; do not expose port 3000 publicly without a
  proxy.

## Configuration reference

See `.env.example`. Highlights:

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP port (3000) |
| `PDM_AI_BASE_URL` / `PDM_AI_API_KEY` / `PDM_AI_MODEL` | Internal AI router (default model `DeepSeek-V4.1-Flash`, temperature 0.2) |
| `MS_TENANT_ID` / `MS_CLIENT_ID` / `MS_GRAPH_SCOPES` | Entra delegated auth; default scopes `Chat.ReadWrite,ChatMessage.Send,User.Read,offline_access` |
| `PUBLIC_BASE_URL` | Public HTTPS URL (webhook challenge + links + secure cookies) |
| `ADMIN_PASSWORD` | Initial admin password (min 16 chars, hashed at rest) |
| `NTFY_URL` / `NTFY_TOPIC` / `NTFY_TOKEN` / `NTFY_DETAIL_MODE` | Push notifications |
| `RECENT_MESSAGE_COUNT` | Recent messages fed as context (default 20) |
| `SUMMARY_TRIGGER_MESSAGE_COUNT` | Chat size before a summary is generated (default 40) |
| `DRAFT_EXPIRY_HOURS` | Pending draft expiry (default 12) |
| `LOG_LEVEL` | pino level |
| `DATA_DIR` | Persistent data directory (`/app/data` in Docker) |

Runtime-adjustable settings (global context, recent count, expiry hours,
summary threshold, notification detail) live in `/settings` and override the
env defaults.

## Tests

```bash
npm test
```

Covers: allowlist/eligibility rules, duplicate message/event handling,
own-message and system-message filtering, the send-only-after-approval
boundary (including a static import scan), single-send on approval,
double-approval protection, rejected/expired drafts, edited-text sending,
style-example learning rules, prompt assembly/context capping, and ntfy
privacy modes. Microsoft Graph and PDM.AI are fully mocked.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `No Microsoft authentication yet` at boot | Run `npm run auth` (or `docker compose exec teams-ai-assistant npm run auth`) |
| Drafts never appear | Check `/subscriptions` health; confirm `PUBLIC_BASE_URL` is publicly reachable over HTTPS; confirm sender/chat is allowed (log shows `message ignored + reason`) |
| `subscription renewal failed` | Token may have expired — rerun `npm run auth`; recreate from `/subscriptions` |
| Sends fail with 401/403 | Consent missing for `ChatMessage.Send`; re-auth or admin consent |
| No notifications | Verify `NTFY_URL`/`NTFY_TOPIC`, subscribe in the ntfy app, check logs for `notification failed` |
| `ADMIN_PASSWORD` error at boot | Must be ≥ 16 chars; it is only read the first time (stored hashed after) |
| Graph validation challenge fails | `PUBLIC_BASE_URL` wrong or TLS invalid; test `curl https://your-domain/webhook?validationToken=abc` — response must be `abc` |
| Duplicate drafts for one message | Should not happen (unique message + event dedupe); check `processed_events` and `messages` tables |
