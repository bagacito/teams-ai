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
import { createPollStateRepo } from '../src/db/repositories/poll-state.js';
import { createIngestionPipeline } from '../src/pipeline/ingest.js';
import { createApp } from '../src/app.js';
import { createPoller } from '../src/teams/poller.js';

export const ME = 'me-user-id';
export const ME_EMAIL = 'me@company.com';
export const ALICE = 'alice-user-id';
export const CHAT1 = 'chat-1-id';
export const CHAT2 = 'chat-2-id';
export const SECRET = 'test-secret';

// ── Fake TeamsProvider (never touches the network or a real login) ──────────
export function createFakeTeamsProvider(ctx) {
  const provider = {
    name: 'fake',
    // Configurable test fixtures:
    chats: [], // { id, title, type, lastMessage: { senderName, content, timestamp, id? } }
    messages: {}, // chatId -> [normalizedMessage]
    // Configurable behaviours:
    statusFn: null,
    getMessagesFn: null,
    listChatsError: null,
    // Call log:
    calls: { status: 0, listChats: 0, getMessages: {}, sendMessage: [] },

    async status() {
      provider.calls.status += 1;
      if (provider.statusFn) return provider.statusFn();
      return { ok: true, authenticated: true, loginRequired: false, error: null };
    },
    async getCurrentUser() {
      return { ok: true, user: { id: ME, displayName: 'Me', email: ME_EMAIL } };
    },
    async listChats({ limit = 100 } = {}) {
      provider.calls.listChats += 1;
      if (provider.listChatsError) return provider.listChatsError;
      return { ok: true, chats: provider.chats.slice(0, limit) };
    },
    async getChat(chatId) {
      const chat = provider.chats.find((c) => c.id === chatId);
      return chat ? { ok: true, chat } : { ok: false, error: 'not found' };
    },
    async getMessages(chatId) {
      provider.calls.getMessages[chatId] = (provider.calls.getMessages[chatId] ?? 0) + 1;
      if (provider.getMessagesFn) return provider.getMessagesFn(chatId);
      return { ok: true, messages: provider.messages[chatId] ?? [] };
    },
    async sendMessage(chatId, text, { replyToMessageId = null } = {}) {
      provider.calls.sendMessage.push({ chatId, replyToMessageId, messageText: text });
      if (ctx.teamsSendShouldFail) {
        return { ok: false, teamsMessageId: null, error: ctx.teamsSendError ?? 'send failed', errorType: ctx.teamsSendErrorType ?? 'PROVIDER_ERROR' };
      }
      return { ok: true, teamsMessageId: `sent-${provider.calls.sendMessage.length}`, error: null };
    },
  };
  return provider;
}

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
    pollStateRepo: createPollStateRepo(db),
  };

  const ctx = {
    db,
    repos,
    myUserId: ME,
    myEmail: ME_EMAIL,
    sessionSecret: 'test-session-secret-at-least-32-chars-long!!',
    logger: {
      child: () => ctx.logger,
      info() {}, warn() {}, error() {}, debug() {},
    },
    notifications: [],
    generated: 0,
  };

  ctx.teamsProvider = createFakeTeamsProvider(ctx);

  // The ONLY send path (mirrors server.js wiring); consumed by routes/drafts.js.
  ctx.teamsSends = ctx.teamsProvider.calls.sendMessage;
  ctx.sendTeamsMessage = ({ chatId, replyToMessageId, messageText }) =>
    ctx.teamsProvider.sendMessage(chatId, messageText, { replyToMessageId });

  ctx.notifier = {
    notifyNewDraft: async (draft) => {
      ctx.notifications.push(draft.id);
    },
  };

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
    // Tests default to the immediate (no-debounce) draft path; debounce tests
    // build their own pipeline with debounceMs > 0.
    debounceMs: 0,
    // Late-binding: tests may reassign ctx.generate.
    generate: (args) => ctx.generate(args),
  });

  ctx.createPollerForCtx = () => createPoller({ ctx, provider: ctx.teamsProvider });

  return ctx;
}

// ── Record/poll fixtures ─────────────────────────────────────────────────────
let eventCounter = 0;

// Normalized provider message with pipeline-record defaults.
export function makeRecord(overrides = {}) {
  const n = ++eventCounter;
  return {
    eventId: overrides.eventId ?? `evt-${n}`,
    teamsMessageId: overrides.messageId ?? overrides.teamsMessageId ?? `msg-${n}`,
    chatId: overrides.chatId ?? CHAT1,
    senderId: overrides.senderId ?? ALICE,
    senderName: overrides.senderName ?? 'Alice',
    senderEmail: overrides.senderEmail ?? 'alice@company.com',
    content: overrides.content ?? overrides.messageText ?? 'Can you review my PR?',
    messageType: overrides.messageType ?? 'message',
    replyTo: overrides.replyTo ?? overrides.replyToMessageId ?? null,
    isMe: overrides.isMe ?? false,
    mentionsMe: overrides.mentionsMe ?? false,
    chatName: overrides.chatName ?? 'Project Alpha',
    timestamp: overrides.timestamp ?? '2026-09-17T15:00:00Z',
  };
}

// Run one record through the pipeline directly (non-poller path).
export async function ingest(ctx, overrides = {}) {
  const record = makeRecord(overrides);
  return ctx.pipeline.processMessage(record, { eventId: record.eventId });
}

// Normalized provider message as the (fake) provider returns it.
export function providerMessage(overrides = {}) {
  const n = ++eventCounter;
  return {
    id: overrides.id ?? `msg-${n}`,
    chatId: overrides.chatId ?? CHAT1,
    senderId: overrides.senderId ?? ALICE,
    senderName: overrides.senderName ?? 'Alice',
    senderEmail: overrides.senderEmail ?? 'alice@company.com',
    content: overrides.content ?? 'Can you review my PR?',
    createdAt: overrides.createdAt ?? overrides.timestamp ?? '2026-09-17T15:00:00Z',
    replyToMessageId: overrides.replyToMessageId ?? null,
    isFromMe: overrides.isFromMe ?? false,
    rawType: overrides.rawType ?? 'message',
  };
}

// Default poller fixture: one chat (Alice + Me participants) with one fresh
// message from Alice. Relevant to the poller via Alice's allowed-user id.
export function seedPoller(ctx, { chat = CHAT1, messages } = {}) {
  ctx.teamsProvider.chats = [
    {
      id: chat,
      title: 'Project Alpha',
      type: 'chat',
      participants: [ALICE, ME],
      lastMessage: { senderName: 'Alice', content: 'Can you review my PR?', timestamp: '2026-09-17T15:00:00Z', id: 'msg-1' },
    },
  ];
  ctx.teamsProvider.messages = { [chat]: messages ?? [providerMessage({ id: 'msg-1' })] };
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
