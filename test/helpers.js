import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { createUserRepo } from '../src/db/repositories/users.js';
import { createChatRepo } from '../src/db/repositories/chats.js';
import { createMessageRepo } from '../src/db/repositories/messages.js';
import { createDraftRepo } from '../src/db/repositories/drafts.js';
import { createStyleRepo } from '../src/db/repositories/style.js';
import { createSummaryRepo } from '../src/db/repositories/summaries.js';
import { createEventRepo } from '../src/db/repositories/events.js';
import { createSettingsRepo } from '../src/db/repositories/settings.js';
import { createAdminAuthRepo } from '../src/db/repositories/admin-auth.js';
import { createIngestionPipeline } from '../src/pipeline/ingest.js';
import { createApp } from '../src/app.js';

export const ME = 'me-user-id';
export const ME_EMAIL = 'me@company.com';
export const ALICE = 'alice-user-id';
export const CHAT1 = 'chat-1-id';
export const CHAT2 = 'chat-2-id';
export const SECRET = 'test-inbound-secret';

export function makeCtx() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);

  const repos = {
    userRepo: createUserRepo(db),
    chatRepo: createChatRepo(db),
    messageRepo: createMessageRepo(db),
    draftRepo: createDraftRepo(db),
    styleRepo: createStyleRepo(db),
    summaryRepo: createSummaryRepo(db),
    eventRepo: createEventRepo(db),
    settingsRepo: createSettingsRepo(db),
    adminAuthRepo: createAdminAuthRepo(db),
  };

  const ctx = {
    db,
    repos,
    myUserId: ME,
    myEmail: ME_EMAIL,
    inboundSecret: SECRET,
    sessionSecret: 'test-session-secret-at-least-32-chars-long!!',
    logger: {
      child: () => ctx.logger,
      info() {}, warn() {}, error() {}, debug() {},
    },
    outboundCalls: [],
    notifications: [],
    generated: 0,
  };

  // Mock outbound Power Automate sender: records calls, never touches network.
  ctx.sendOutbound = async ({ draftId, chatId, replyToMessageId, messageText, dryRun }) => {
    ctx.outboundCalls.push({ draftId, chatId, replyToMessageId, messageText, dryRun });
    if (ctx.outboundShouldFail) {
      return { ok: false, httpStatus: ctx.outboundFailStatus ?? 500, teamsMessageId: null, error: ctx.outboundFailError ?? 'flow failed', requestId: 'req-x' };
    }
    return { ok: true, httpStatus: 200, teamsMessageId: `sent-${ctx.outboundCalls.length}`, error: null, requestId: `req-${ctx.outboundCalls.length}` };
  };

  // Mock notifier.
  ctx.notifier = {
    notifyNewDraft: async (draft) => {
      ctx.notifications.push(draft.id);
    },
  };

  // Mock AI generation.
  ctx.generate = async ({ context }) => {
    ctx.generated += 1;
    ctx.lastContext = context;
    return `mock reply ${ctx.generated}`;
  };

  repos.adminAuthRepo.ensureInitialized('x'.repeat(20));

  ctx.pipeline = createIngestionPipeline({
    eventRepo: repos.eventRepo,
    userRepo: repos.userRepo,
    chatRepo: repos.chatRepo,
    messageRepo: repos.messageRepo,
    draftRepo: repos.draftRepo,
    summaryRepo: repos.summaryRepo,
    styleRepo: repos.styleRepo,
    settingsRepo: repos.settingsRepo,
    notifier: ctx.notifier,
    myUserId: ME,
    myEmail: ME_EMAIL,
    generate: ctx.generate,
  });

  return ctx;
}

// Standard Power Automate inbound payload.
export function inboundPayload(overrides = {}) {
  return {
    eventId: overrides.eventId ?? 'evt-1',
    messageId: overrides.messageId ?? 'msg-1',
    chatId: overrides.chatId ?? CHAT1,
    chatName: overrides.chatName ?? 'Project Alpha',
    senderId: overrides.senderId ?? ALICE,
    senderName: overrides.senderName ?? 'Alice',
    senderEmail: overrides.senderEmail ?? 'alice@company.com',
    messageText: overrides.messageText ?? 'Can you review my PR?',
    messageType: overrides.messageType ?? 'message',
    timestamp: overrides.timestamp ?? '2026-09-17T15:00:00Z',
    replyToMessageId: overrides.replyToMessageId ?? null,
    mentionedMe: overrides.mentionedMe ?? false,
  };
}

// Run a payload through the pipeline directly (non-HTTP path).
export async function ingest(ctx, overrides = {}) {
  const { recordFromPayload } = await import('../src/pipeline/ingest.js');
  const payload = inboundPayload(overrides);
  const record = recordFromPayload(payload, { myUserId: ME, myEmail: ME_EMAIL });
  return ctx.pipeline.processMessage(record, { eventId: payload.eventId });
}

export function seed(ctx, { aliceAllowed = true, chatAllowed = false } = {}) {
  if (aliceAllowed) ctx.repos.userRepo.add(ALICE, 'Alice');
  if (chatAllowed) ctx.repos.chatRepo.add(CHAT2, 'Group Chat');
}

// Full HTTP app for endpoint tests.
export async function makeHttpApp() {
  const ctx = makeCtx();
  const app = createApp(ctx);
  await app.ready();
  return { ctx, app };
}
