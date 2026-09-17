import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { createUserRepo } from '../src/db/repositories/users.js';
import { createChatRepo } from '../src/db/repositories/chats.js';
import { createMessageRepo } from '../src/db/repositories/messages.js';
import { createDraftRepo } from '../src/db/repositories/drafts.js';
import { createStyleRepo } from '../src/db/repositories/style.js';
import { createSummaryRepo } from '../src/db/repositories/summaries.js';
import { createSubscriptionRepo } from '../src/db/repositories/subscriptions.js';
import { createEventRepo } from '../src/db/repositories/events.js';
import { createSettingsRepo } from '../src/db/repositories/settings.js';
import { createAdminAuthRepo } from '../src/db/repositories/admin-auth.js';
import { createIngestionPipeline } from '../src/teams/webhook.js';

export const ME = 'me-user-id';
export const ALICE = 'alice-user-id';
export const BOB = 'bob-user-id';
export const CHAT1 = 'chat-1-id';
export const CHAT2 = 'chat-2-id';

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
    subRepo: createSubscriptionRepo(db),
    eventRepo: createEventRepo(db),
    settingsRepo: createSettingsRepo(db),
    adminAuthRepo: createAdminAuthRepo(db),
  };

  const ctx = {
    db,
    repos,
    myUserId: ME,
    logger: {
      child: () => ctx.logger,
      info() {}, warn() {}, error() {}, debug() {},
    },
    sendCalls: [],
    notifications: [],
    generated: 0,
  };

  // Mock Teams send: records calls, never touches the network.
  ctx.sendTeamsMessage = async (chatId, text) => {
    ctx.sendCalls.push({ chatId, text });
    return { id: `sent-${ctx.sendCalls.length}` };
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
    generate: ctx.generate,
    fetchMessage: async (chatId, messageId) => ctx.graphMessages?.[messageId] ?? ctx.graphMessage,
    fetchChat: async () => ({ topic: 'Project Alpha' }),
  });

  return ctx;
}

// Standard Graph-shaped message for fetchMessage mock.
export function graphMessage({ senderId = ALICE, senderName = 'Alice', content = 'hello', mentions = [], messageType = 'message' } = {}) {
  return {
    id: 'graph-msg-id',
    messageType,
    from: { user: { id: senderId, displayName: senderName } },
    body: { content, contentType: 'text' },
    mentions,
  };
}

export function notification({ eventId = 'evt-1', chatId = CHAT1, messageId = 'msg-1', changeType = 'created' } = {}) {
  return {
    id: eventId,
    changeType,
    resource: `chats('${chatId}')/messages('${messageId}')`,
    resourceData: { id: `${chatId};;${messageId}` },
  };
}

export function seed(ctx, { aliceAllowed = true, chatAllowed = false } = {}) {
  if (aliceAllowed) ctx.repos.userRepo.add(ALICE, 'Alice');
  if (chatAllowed) ctx.repos.chatRepo.add(CHAT2, 'Group Chat');
}
