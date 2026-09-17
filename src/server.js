import path from 'node:path';
import crypto from 'node:crypto';
import { getDatabase } from './db/database.js';
import { createUserRepo } from './db/repositories/users.js';
import { createChatRepo } from './db/repositories/chats.js';
import { createMessageRepo } from './db/repositories/messages.js';
import { createDraftRepo } from './db/repositories/drafts.js';
import { createStyleRepo } from './db/repositories/style.js';
import { createSummaryRepo } from './db/repositories/summaries.js';
import { createSubscriptionRepo } from './db/repositories/subscriptions.js';
import { createEventRepo } from './db/repositories/events.js';
import { createSettingsRepo } from './db/repositories/settings.js';
import { createAdminAuthRepo } from './db/repositories/admin-auth.js';
import { logger } from './logging.js';
import { createNotifier } from './notifications/notifier.js';
import { createIngestionPipeline } from './teams/webhook.js';
import { getAuth } from './teams/graph.js';
import { sendChatMessage } from './teams/send.js';
import { renewDueSubscriptions } from './teams/subscriptions.js';
import { createApp } from './app.js';
import { refreshSummary } from './routes/drafts.js';
import { summaryTriggerCount } from './context/summaries.js';

export function buildContext({ dataDir } = {}) {
  const dir = dataDir || process.env.DATA_DIR || './data';
  const db = getDatabase(dir);
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
  repos.adminAuthRepo.ensureInitialized(process.env.ADMIN_PASSWORD);

  const settingsRepo = repos.settingsRepo;
  let sessionSecret = settingsRepo.get('session_secret');
  if (!sessionSecret) {
    sessionSecret = crypto.randomBytes(32).toString('hex');
    settingsRepo.set('session_secret', sessionSecret);
  }

  const clientState = settingsRepo.get('webhook_client_state');
  if (!clientState) {
    settingsRepo.set('webhook_client_state', crypto.randomBytes(24).toString('hex'));
  }

  const ctx = {
    db,
    repos,
    settingsRepo,
    sessionSecret,
    clientState: settingsRepo.get('webhook_client_state'),
    logger,
    myUserId: settingsRepo.get('my_user_id') || null,
    dataDir: path.resolve(dir),
  };

  ctx.notifier = createNotifier({});
  ctx.sendTeamsMessage = sendChatMessage;
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
    myUserId: ctx.myUserId,
    logger,
  });

  return ctx;
}

export async function start() {
  const ctx = buildContext();

  // Resolve my user id (needed to ignore own messages and tag sent ones).
  let auth = null;
  try {
    auth = getAuth(ctx.dataDir);
  } catch (err) {
    logger.warn({ err: err.message }, 'Microsoft auth not configured yet (MS_TENANT_ID/MS_CLIENT_ID)');
  }
  if (auth?.isAuthenticated()) {
    try {
      const myId = await auth.getMyUserId();
      if (myId && myId !== ctx.myUserId) {
        ctx.myUserId = myId;
        ctx.settingsRepo.set('my_user_id', myId);
        logger.info('authenticated user resolved');
      }
    } catch (err) {
      logger.warn({ errName: err?.name }, 'could not resolve /me; run `npm run auth`');
    }
  } else {
    logger.warn('No Microsoft authentication yet. Run `npm run auth` inside the container.');
  }

  const app = createApp(ctx);
  const port = Number(process.env.PORT) || 3000;
  await app.listen({ port, host: '0.0.0.0' });
  logger.info({ port }, 'teams-ai-assistant started');

  // Background worker: draft expiry + subscription renewal + summaries.
  const expiryHours = Number(process.env.DRAFT_EXPIRY_HOURS) || 12;
  const worker = setInterval(() => runWorkerCycle(ctx, { expiryHours }), 5 * 60_000);
  worker.unref();

  // Initial subscription sweep shortly after boot (give Graph a moment).
  setTimeout(() => {
    runWorkerCycle(ctx, { expiryHours }).catch((err) =>
      logger.warn({ err: err.message }, 'initial worker cycle failed'),
    );
  }, 15_000).unref();

  const shutdown = async () => {
    clearInterval(worker);
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

export async function runWorkerCycle(ctx, { expiryHours }) {
  const expired = ctx.repos.draftRepo.expireOld(expiryHours);
  if (expired > 0) {
    logger.info({ expired }, 'pending drafts expired');
  }

  try {
    await renewDueSubscriptions({ subRepo: ctx.repos.subRepo });
  } catch (err) {
    logger.warn({ err: err.message }, 'subscription renewal cycle failed');
  }

  // Auto-summarize chats past the trigger threshold with stale summaries.
  try {
    const trigger = summaryTriggerCount(ctx.settingsRepo);
    for (const chat of ctx.repos.chatRepo.list()) {
      const count = ctx.repos.messageRepo.countForChat(chat.teams_chat_id);
      if (count < trigger) continue;
      const summary = ctx.repos.summaryRepo.get(chat.teams_chat_id);
      const latest = ctx.repos.messageRepo.recentForChat(chat.teams_chat_id, 1)[0];
      if (summary && summary.last_message_id === latest?.teams_message_id) continue;
      await refreshSummary(ctx, chat.teams_chat_id);
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'summary refresh cycle failed');
  }
}

// Allow direct execution
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  start().catch((err) => {
    logger.error({ err: err.message }, 'fatal startup error');
    process.exit(1);
  });
}
