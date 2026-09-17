# teams-ai-assistant

A self-hosted assistant that watches selected Microsoft Teams chats, drafts
suggested replies with an internal OpenAI-compatible AI API (**PDM.AI**), and
lets you review them in a small admin UI before anything is sent.

```
Microsoft Teams
   ↕  (browser-session APIs via local msteams-mcp)
local Teams MCP/CLI adapter
   ↕
TeamsProvider abstraction  ← the ONLY Teams boundary in this app
   ↕
teams-ai-assistant (Fastify + SQLite)   →  pending draft  →  ntfy notification
                                                          →  YOU approve  →  reply sent
```

> **Central security guarantee: NO message is ever sent to Microsoft Teams
> without explicit human approval in the admin UI.** The ingestion pipeline,
> the AI module and the poller have no send capability at all; the send path is
> wired exclusively into the approval routes and enforced by static tests
> (`test/safety.test.mjs`).

## Architecture

- **TeamsProvider abstraction** (`src/teams/provider.js`): every Teams
  interaction goes through this interface (`status()`, `getCurrentUser()`,
  `listChats()`, `getChat()`, `getMessages()`, `sendMessage()`).
- **msteams-mcp provider** (`src/teams/providers/msteams-mcp.js`): the current
  implementation drives the local [`msteams-mcp`](https://github.com/hickeroar/msteams-mcp)
  project through its CLI. It uses your normal Teams **browser session**
  (no Azure/Entra app registration, no MSAL, no Graph).
- **Poller** (`src/teams/poller.js`): polls Teams every
  `TEAMS_POLL_INTERVAL_SECONDS` (default 60), keeps a per-chat cursor
  (`chat_poll_state` table), skips unchanged chats, deduplicates by Teams
  message ID, and feeds new messages into the draft pipeline.
- **Everything else unchanged**: PDM.AI drafting, chat context/history, rolling
  summaries, style learning, SQLite storage, ntfy notifications, approval UI,
  admin auth.

### Why the isolation?

The msteams-mcp adapter uses **undocumented Microsoft Teams web APIs**. They
can change or break at any time. All provider-specific knowledge (CLI tool
names, payload shapes, session handling) is contained in
`src/teams/providers/msteams-mcp.js` and normalized in
`src/teams/normalize.js`. To replace Teams access later (e.g. with documented
Microsoft Graph), implement another provider module with the same six methods
and register it in `src/teams/provider.js` — nothing else in the application
changes.

> **Warning:** the current Teams integration relies on undocumented Teams APIs
> used by the Teams web client. It is **unsupported** by Microsoft and may
> break when Microsoft changes these APIs. This is distinct from the
> documented Microsoft Graph API, which would be the supported (but
> registration-requiring) alternative.

## Teams integration setup (first run)

### 1. Install msteams-mcp on the host

```bash
git clone https://github.com/hickeroar/msteams-mcp.git /opt/msteams-mcp
cd /opt/msteams-mcp
npm install
npm run build        # optional; the CLI runs from source via tsx
```

Requirements: Node.js 18+, Google Chrome (for the initial browser login).

> The application never downloads arbitrary software at startup; you install
> and build msteams-mcp yourself and point the app at it.

### 2. Initial browser login (manual, on the host)

```bash
cd /opt/msteams-mcp
MSTEAMS_SESSION_PATH=/path/to/teams-session npm run cli -- login
```

A browser opens; sign in with your normal Microsoft/Teams account. Session
files are stored under `$MSTEAMS_SESSION_PATH/.teams-mcp-server/`
(the app sets `HOME=$MSTEAMS_SESSION_PATH` when it calls the CLI).

> The application never asks for or collects Microsoft credentials. Login
> happens in a real browser, interactively, by you.

Re-run the same command whenever authentication expires (see
[Troubleshooting](#troubleshooting)).

### 3. Point the app at it

```env
TEAMS_PROVIDER=msteams-mcp
MSTEAMS_MCP_PATH=/opt/msteams-mcp        # path inside the container
MSTEAMS_SESSION_PATH=/app/teams-session  # path inside the container
```

### 4. Docker volumes

`docker-compose.yml` mounts:

| Volume | Purpose |
|---|---|
| `./data:/app/data` | SQLite database + app state |
| `${MSTEAMS_MCP_PATH_HOST:-/opt/msteams-mcp}:/opt/msteams-mcp:ro` | the msteams-mcp checkout (read-only) |
| `./teams-session:/app/teams-session` | Teams session (sensitive credentials) |

Set `MSTEAMS_MCP_PATH_HOST=/opt/msteams-mcp` (host path) in `.env` if yours
differs. Session state is never inside the Docker image.

**Note:** the msteams-mcp CLI may need a Chrome binary for some flows. The
initial login is done on the host (step 2); if provider calls inside the
container ever fail with browser-launch errors, extend the image:

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends wget gnupg \
 && wget -qO- https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor > /usr/share/keyrings/google.gpg \
 && echo "deb [signed-by=/usr/share/keyrings/google.gpg] https://dl.google.com/linux/chrome/deb stable main" > /etc/apt/sources.list.d/google-chrome.list \
 && apt-get update && apt-get install -y --no-install-recommends google-chrome-stable \
 && rm -rf /var/lib/apt/lists/*
```

### 5. Configure polling

```env
TEAMS_POLL_INTERVAL_SECONDS=60   # default; hard floor 15
TEAMS_POLL_MIN_INTERVAL_SECONDS=15
```

Poll behaviour:

- lists recent chats once per cycle and only fetches history for chats that
  are relevant (approved chat, or a chat whose ID/participants contain an
  approved user);
- skips chats whose last message matches the stored cursor;
- sorts new messages oldest→newest, deduplicates by Teams message ID;
- your own messages are stored (for history/style) but never drafted;
- one chat failing does not stop the others; repeated provider failures back
  off exponentially (up to 10 minutes).

Only one poll runs at a time; overlapping triggers (e.g. **Poll now** during
an active poll) are skipped.

### 6. Discover chats and approve users

- **Chats** (`/chats` → **Discover Teams chats**): lists recent Teams
  conversations with title, ID, participants and last activity. Click
  **Add to approved chats** — no more copying opaque chat IDs.
- **Users** (`/users`): senders actually seen in stored messages appear under
  **Known senders**; click **Allow** to add them.

Approval semantics (unchanged): a message is eligible when its **sender is an
approved user** OR its **chat is an approved chat** (for group chats, approving
the chat means any participant can trigger drafting).

### 7. Test polling and draft approval

1. Wait for a poll cycle (or **Integrations → Poll now**).
2. An eligible message (question/request/mention) produces a **pending draft**
   and an ntfy notification.
3. In **Drafts**, choose **Approve & Send**, **Edit** (edited text is sent
   instead and learned as a better style example), or **Reject**.
4. The send goes through `TeamsProvider.sendMessage()` — exactly once, with an
   atomic state transition that makes double-click retries impossible. Failed
   sends can be retried; successful ones record the Teams message ID.

The **Integrations** page shows provider status (Connected / Login required /
Error / Disconnected), last successful poll, chats scanned, messages
discovered, pending drafts, and **Poll now / Pause / Resume** controls. It
never displays tokens or session content.

## Configuration reference

| Variable | Required | Description |
|---|---|---|
| `PORT` | no | HTTP port (default 3000). |
| `PUBLIC_BASE_URL` | recommended | Public URL used in notification links. |
| `PDM_AI_BASE_URL` | yes | OpenAI-compatible API base (default `https://router.ai.pdmfc.com/v1`). |
| `PDM_AI_API_KEY` | yes | PDM.AI key. |
| `PDM_AI_MODEL` | no | Default `DeepSeek-V4.1-Flash`. |
| `ADMIN_PASSWORD` | yes | Admin UI passphrase (min 16 chars, hashed at rest). |
| `TEAMS_PROVIDER` | no | `msteams-mcp` (default, only value). |
| `MSTEAMS_MCP_PATH` | yes (for Teams) | Path to the msteams-mcp checkout. |
| `MSTEAMS_SESSION_PATH` | no | Session dir (default `/app/teams-session`). |
| `TEAMS_POLL_INTERVAL_SECONDS` | no | Poll interval (default 60). |
| `TEAMS_POLL_MIN_INTERVAL_SECONDS` | no | Hard floor (default 15). |
| `MSTEAMS_MCP_TIMEOUT_MS` | no | Per CLI call timeout (default 90000). |
| `NTFY_URL` / `NTFY_TOPIC` / `NTFY_TOKEN` / `NTFY_DETAIL_MODE` | no | ntfy notifications (`minimal` hides contents). |
| `RECENT_MESSAGE_COUNT` / `SUMMARY_TRIGGER_MESSAGE_COUNT` / `DRAFT_EXPIRY_HOURS` | no | Context sizing / summary trigger / draft TTL. |
| `DATA_DIR` | no | SQLite location (default `./data`). |
| `LOG_LEVEL` | no | pino level. |

Runtime settings (admin UI `/settings`): my user id/email, global context,
capture-own-messages-style, draft expiry, summary trigger, ntfy detail mode.

## Startup behaviour

At startup the app: initializes the database → PDM.AI client → Teams provider
→ checks Teams authentication → starts the web server → starts the poller only
when Teams is authenticated and polling is not paused. **If Teams is not
authenticated the app still starts**: the admin UI, drafts and history remain
fully usable, and polling reports "authentication required" instead of
crashing.

## Security considerations

- **Human-in-the-loop send**: enforced structurally and by
  `test/safety.test.mjs` (only `routes/drafts.js` may send; the pipeline, AI
  module and poller have no send capability).
- **Teams session directory = credentials.** Treat `teams-session/` as you
  would a password store:
  - never logged, never exposed via UI/API, never committed, never in images;
  - recommended permissions: `chmod 700 teams-session && chown -R 1000:1000 teams-session`
    (the container's `node` user is uid 1000);
  - excluded from backups by default (it is a plain directory outside `data/`);
    if you must back it up, encrypt it.
- Admin UI: session cookies (httpOnly, Secure when behind HTTPS), rotating
  CSRF tokens, helmet CSP, rate limiting; all user/Teams content is
  HTML-escaped.
- Logs are pino with redaction of token/secret fields; Teams message contents
  are not logged.
- Raw provider payloads are not stored (storage of raw payloads is disabled by
  default).

## Troubleshooting

**"Login required" on the Integrations page / sends failing with auth errors**

The Teams browser session expired (tokens refresh automatically while possible;
a full expiry needs an interactive login). Fix:

```bash
cd /opt/msteams-mcp
MSTEAMS_SESSION_PATH=./teams-session npm run cli -- login
```

(use the same session path that is mounted into the container; if the session
is badly corrupted, `npm run cli -- login --force` starts fresh).

**Poller idle although connected** — check whether polling is paused
(Integrations → Resume) and whether any chat/user is approved.

**Provider errors like "MSTEAMS_MCP_PATH is not set or invalid"** — the path
must point at the checkout *inside the container* (`/opt/msteams-mcp`), not the
host path; the host path goes into `MSTEAMS_MCP_PATH_HOST` for the compose
mount.

**Undocumented-API breakage** — if Teams calls suddenly fail en masse after a
Microsoft change, check for msteams-mcp updates (`git pull && npm install &&
npm run build`), then restart the container.

## Replacing the provider later

To move to documented Microsoft Graph (or anything else):

1. Create `src/teams/providers/<name>.js` exporting
   `create<Name>Provider({ logger })` implementing the six interface methods
   and returning normalized messages (`src/teams/normalize.js`).
2. Register it in the `createTeamsProvider()` switch in
   `src/teams/provider.js` and add a `TEAMS_PROVIDER=<name>` value.
3. Keep `sendMessage()` reachable only from the approval wiring in
   `src/server.js` (the safety tests will enforce it).

No changes are needed in the pipeline, poller logic, AI modules, UI or tests
beyond the provider test fixtures.

## Development

```bash
npm install
npm test          # node --test; all tests use a fake TeamsProvider, no real login
npm run dev
docker compose up -d --build
```

Project layout highlights: `src/teams/` (provider + adapter + poller),
`src/pipeline/ingest.js` (store → allowlist → shouldDraft → draft → notify,
never sends), `src/routes/drafts.js` (approval + the single send path),
`src/db/` (SQLite + migrations), `test/` (unit + safety-boundary tests).
