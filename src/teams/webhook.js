import crypto from 'node:crypto';
import { logger } from '../logging.js';
import { getChat, getChatMessage } from './graph.js';
import { isMessageAllowed } from '../policy/allowlist.js';
import { shouldDraft } from '../policy/should-draft.js';
import { generateDraft } from '../ai/draft.js';
import { getRecentMessages, getChatContext } from '../context/chat-context.js';

// Teams change-notification webhook handling + draft ingestion pipeline.
//
// SAFETY: this pipeline creates a pending DRAFT and notifies. It stops there.
// It never sends anything to Teams. Sending happens only in routes/drafts.js
// after explicit human approval.

export function parseResource(resource) {
  if (!resource) return null;
  // chats('{id}')/messages('{id}')
  let m = resource.match(/chats\('([^']+)'\)\/messages\('([^']+)'\)/);
  if (m) return { chatId: m[1], messageId: m[2] };
  // chats/{id}/messages/{id}
  m = resource.match(/chats\/([^/]+)\/messages\/(.+)$/);
  if (m) return { chatId: decodeURIComponent(m[1]), messageId: decodeURIComponent(m[2]) };
  return null;
}

export function parseCompositeId(id) {
  // resourceData.id may be "chatId;;messageId"
  if (!id) return null;
  const parts = id.split(';;');
  if (parts.length === 2 && parts[0].includes('@') || parts.length === 2) {
    return { chatId: parts[0], messageId: parts[1] };
  }
  return null;
}

// Extract chat/message ids from a notification, trying several Graph shapes.
export function extractIds(notification) {
  const rd = notification.resourceData || {};
  return (
    parseResource(notification.resource) ||
    parseCompositeId(rd.id) || { chatId: null, messageId: rd.id ?? null }
  );
}

// ── Webhook endpoint handling ────────────────────────────────────────────────

// Microsoft sends a validation token as a query param on subscription creation.
export function handleValidation(query) {
  const token = query.validationToken;
  if (!token) return null;
  const decoded = decodeURIComponent(String(token));
  return { status: 200, body: decoded, headers: { 'content-type': 'text/plain' } };
}

export function verifyClientState(notification, clientState) {
  if (!clientState) return true; // no state configured -> accept (single-tenant setup)
  return notification.clientState === clientState;
}

// ── Notification → draft pipeline ────────────────────────────────────────────

export function createIngestionPipeline(deps) {
  const {
    eventRepo,
    userRepo,
    chatRepo,
    messageRepo,
    draftRepo,
    summaryRepo,
    styleRepo,
    settingsRepo,
    notifier,
    myUserId,
    fetchMessage = getChatMessage,
    fetchChat = getChat,
    generate = generateDraft,
  } = deps;

  const policy = {
    isUserAllowed: (id) => {
      if (!id) return false;
      if (myUserId && id === myUserId) return false;
      const u = userRepo.getByEntraId(id);
      return !!u && !!u.enabled;
    },
    isChatAllowed: (id) => {
      if (!id) return false;
      const c = chatRepo.getByChatId(id);
      return !!c && !!c.enabled;
    },
    getUser: (id) => userRepo.getByEntraId(id),
    getChat: (id) => chatRepo.getByChatId(id),
  };

  async function processNotification(notification, { clientState } = {}) {
    const eventId = notification.id;
    const log = logger.child({ component: 'webhook' });

    if (!verifyClientState(notification, clientState)) {
      log.warn({ eventId }, 'notification rejected: clientState mismatch');
      return { processed: false, reason: 'client-state-mismatch' };
    }

    // Deduplicate at event level.
    if (!eventRepo.firstTimeSeen(eventId ?? `anon-${crypto.randomUUID()}`)) {
      log.info({ eventId }, 'duplicate event ignored');
      return { processed: false, reason: 'duplicate-event' };
    }

    if (notification.changeType && notification.changeType !== 'created') {
      return { processed: false, reason: `unsupported-change-type:${notification.changeType}` };
    }

    const { chatId, messageId } = extractIds(notification);
    if (!chatId || !messageId) {
      log.warn({ eventId }, 'notification ignored: cannot resolve chat/message id');
      return { processed: false, reason: 'unresolvable-ids' };
    }

    // Deduplicate at message level (unique constraint + explicit check).
    if (messageRepo.getById(messageId)) {
      log.info({ eventId, messageId }, 'duplicate message ignored');
      return { processed: false, reason: 'duplicate-message' };
    }

    // Fetch full message for sender/content/mentions.
    let msg;
    try {
      msg = await fetchMessage(chatId, messageId);
    } catch (err) {
      log.warn({ eventId, messageId, errStatus: err.status }, 'failed to fetch message');
      return { processed: false, reason: 'fetch-failed' };
    }

    const senderId = msg.from?.user?.id ?? '';
    const senderName = msg.from?.user?.displayName ?? '';
    const isMe = !!myUserId && senderId === myUserId;

    const record = {
      teamsMessageId: messageId,
      chatId,
      senderId,
      senderName,
      content: msg.body?.content ?? '',
      messageType: msg.messageType ?? 'message',
      isMe,
      mentionsMe: detectMentionsMe(msg, myUserId),
    };

    // Ignore my own messages (never draft replies to myself, still stored for history).
    if (isMe) {
      messageRepo.save(record);
      // Optionally keep my own sent messages as writing-style candidates.
      if (
        (settingsRepo.get('capture_own_messages_style', 'true') ?? '') === 'true' &&
        isUsableStyleCandidate(record.content)
      ) {
        styleRepo.add(record.content, 'teams', chatId);
      }
      log.info({ messageId }, 'own message stored, no draft');
      return { processed: false, reason: 'own-message' };
    }

    // Ignore unsupported/system message types.
    if (record.messageType !== 'message') {
      messageRepo.save(record);
      log.info({ messageId, type: record.messageType }, 'unsupported message type ignored');
      return { processed: false, reason: `unsupported-type:${record.messageType}` };
    }

    // Allowlist check: allowed sender OR allowed chat.
    if (!isMessageAllowed(policy, { senderId, chatId })) {
      log.info(
        { messageId, chatId, senderId },
        'message ignored: sender and chat not allowed',
      );
      return { processed: false, reason: 'not-allowed' };
    }

    // Save incoming message for history (unique constraint prevents dupes).
    const saved = messageRepo.save(record);
    if (!saved) {
      log.info({ messageId }, 'duplicate message ignored (constraint)');
      return { processed: false, reason: 'duplicate-message' };
    }

    // Evaluate response-worthiness.
    const decision = shouldDraft(record);
    if (!decision.draft) {
      log.info({ messageId, reason: decision.reason }, 'message ignored');
      return { processed: false, reason: decision.reason };
    }

    // Build context and generate the draft.
    const chatRow = policy.getChat(chatId);
    const chatName = chatRow?.display_name || (await safeChatName(chatId)) || chatId;
    const draft = await createDraftForMessage({
      record,
      chatName,
      chatRow,
      settingsRepo,
      summaryRepo,
      styleRepo,
      draftRepo,
      messageRepo,
      generate,
    });

    if (!draft) {
      log.error({ messageId }, 'draft generation failed');
      return { processed: false, reason: 'generation-failed' };
    }

    log.info(
      { messageId, chatId, draftId: draft.id, sender: senderName },
      'draft generated',
    );

    // Notify — STOP THERE. Nothing is sent to Teams.
    if (notifier) {
      try {
        await notifier.notifyNewDraft(draft, { chatName });
      } catch (err) {
        log.warn({ err: err.message }, 'notification failed (draft still pending)');
      }
    }

    return { processed: true, draftId: draft.id };
  }

  return { processNotification };
}

function detectMentionsMe(msg, myUserId) {
  if (!myUserId || !Array.isArray(msg.mentions)) return false;
  return msg.mentions.some((m) => m.mentioned?.user?.id === myUserId);
}

// Only substantive own messages become style candidates.
function isUsableStyleCandidate(content) {
  const text = String(content || '').trim();
  if (text.length < 15 || text.length > 2000) return false;
  if (/^<gif|^<image/i.test(text)) return false;
  return true;
}

async function safeChatName(chatId) {
  try {
    const chat = await fetchChat(chatId);
    return chat?.topic || null;
  } catch {
    return null;
  }
}

export async function createDraftForMessage({
  record,
  chatName,
  chatRow,
  settingsRepo,
  summaryRepo,
  styleRepo,
  draftRepo,
  messageRepo,
  generate = generateDraft,
  recentCount,
}) {
  const limit = recentCount || Number(process.env.RECENT_MESSAGE_COUNT) || 20;
  const recentMessages = await getRecentMessages(record.chatId, limit, messageRepo);
  const summaryRow = summaryRepo.get(record.chatId);
  const globalContext = settingsRepo.get('global_context', '') || '';

  const context = {
    styleExamples: styleRepo.enabledExamples(),
    globalContext,
    chatContext: chatRow?.context ?? getChatContext(record.chatId, settingsRepo),
    summary: summaryRow?.summary ?? '',
    recentMessages,
    incomingMessage: {
      senderName: record.senderName,
      content: record.content,
    },
  };

  let reply;
  try {
    reply = await generate({ context });
  } catch (err) {
    logger.error({ err: err.message, messageId: record.teamsMessageId }, 'AI generation failed');
    return null;
  }
  if (!reply || !reply.trim()) {
    logger.warn({ messageId: record.teamsMessageId }, 'AI returned empty reply');
    return null;
  }

  return draftRepo.create({
    chatId: record.chatId,
    sourceMessageId: record.teamsMessageId,
    senderId: record.senderId,
    senderName: record.senderName,
    originalMessage: record.content,
    generatedReply: reply,
  });
}
