import { logger } from '../logging.js';
import { isMessageAllowed } from '../policy/allowlist.js';
import { shouldDraft } from '../policy/should-draft.js';
import { generateDraft } from '../ai/draft.js';
import { getRecentMessages, getChatContext } from '../context/chat-context.js';

// ─────────────────────────────────────────────────────────────────────────────
// Draft ingestion pipeline.
//
// SAFETY: this pipeline creates a pending DRAFT and notifies. It stops there.
// It never sends anything to Teams and has no reference to any outbound
// sender. Sending happens only in routes/drafts.js after explicit human
// approval.
// ─────────────────────────────────────────────────────────────────────────────

// Message record derived from a validated Power Automate inbound payload.
export function recordFromPayload(payload, { myUserId = null, myEmail = null } = {}) {
  const senderId = payload.senderId;
  const isMe =
    (myUserId && senderId === myUserId) ||
    (myEmail && payload.senderEmail && payload.senderEmail.toLowerCase() === myEmail.toLowerCase());
  return {
    teamsMessageId: payload.messageId,
    chatId: payload.chatId,
    senderId,
    senderName: payload.senderName || '',
    content: payload.messageText || '',
    messageType: payload.messageType || 'message',
    replyTo: payload.replyToMessageId || null,
    isMe,
    mentionsMe: payload.mentionedMe === true,
    chatName: payload.chatName || '',
    timestamp: payload.timestamp || '',
  };
}

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
    myUserId = null,
    myEmail = null,
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

  // Processes one validated inbound record. Returns { processed, reason, draftId }.
  async function processMessage(record, { eventId } = {}) {
    const log = logger.child({ component: 'pipeline' });

    // Deduplicate at event level (Power Automate retries).
    if (!eventRepo.firstTimeSeen(eventId ?? `anon-${record.teamsMessageId}`, record.teamsMessageId)) {
      log.info({ eventId }, 'duplicate event ignored');
      return { processed: false, reason: 'duplicate-event' };
    }

    // Deduplicate at message level (unique constraint + explicit check).
    if (messageRepo.getById(record.teamsMessageId)) {
      log.info({ messageId: record.teamsMessageId }, 'duplicate message ignored');
      return { processed: false, reason: 'duplicate-message' };
    }

    // My own messages: store for history, optionally as style candidate, no draft.
    if (record.isMe) {
      messageRepo.save(record);
      if (
        (settingsRepo.get('capture_own_messages_style', 'true') ?? '') === 'true' &&
        isUsableStyleCandidate(record.content)
      ) {
        styleRepo.add(record.content, 'teams', record.chatId);
      }
      log.info({ messageId: record.teamsMessageId }, 'own message stored, no draft');
      return { processed: false, reason: 'own-message' };
    }

    // Ignore unsupported/system message types.
    if (record.messageType !== 'message') {
      messageRepo.save(record);
      log.info({ messageId: record.teamsMessageId, type: record.messageType }, 'unsupported message type ignored');
      return { processed: false, reason: `unsupported-type:${record.messageType}` };
    }

    // Allowlist check: allowed sender OR allowed chat.
    if (!isMessageAllowed(policy, { senderId: record.senderId, chatId: record.chatId })) {
      log.info(
        { messageId: record.teamsMessageId, chatId: record.chatId, senderId: record.senderId },
        'message ignored: sender and chat not allowed',
      );
      return { processed: false, reason: 'not-allowed' };
    }

    // Save incoming message for history (unique constraint prevents dupes).
    const saved = messageRepo.save(record);
    if (!saved) {
      log.info({ messageId: record.teamsMessageId }, 'duplicate message ignored (constraint)');
      return { processed: false, reason: 'duplicate-message' };
    }

    // Evaluate response-worthiness.
    const decision = shouldDraft(record);
    if (!decision.draft) {
      log.info({ messageId: record.teamsMessageId, reason: decision.reason }, 'message ignored');
      return { processed: false, reason: decision.reason };
    }

    // Build context and generate the draft.
    const chatRow = policy.getChat(record.chatId);
    const draft = await createDraftForMessage({
      record,
      chatName: chatRow?.display_name || record.chatName || record.chatId,
      chatRow,
      settingsRepo,
      summaryRepo,
      styleRepo,
      draftRepo,
      messageRepo,
      generate,
    });

    if (!draft) {
      log.error({ messageId: record.teamsMessageId }, 'draft generation failed');
      return { processed: false, reason: 'generation-failed' };
    }

    log.info(
      { messageId: record.teamsMessageId, chatId: record.chatId, draftId: draft.id, sender: record.senderName },
      'draft generated',
    );

    // Notify — STOP THERE. Nothing is sent to Teams.
    if (notifier) {
      try {
        await notifier.notifyNewDraft(draft, { chatName: chatRow?.display_name || record.chatName });
        log.info({ draftId: draft.id }, 'notification sent');
      } catch (err) {
        log.warn({ err: err.message }, 'notification failed (draft still pending)');
      }
    }

    return { processed: true, draftId: draft.id };
  }

  return { processMessage };
}

// ── Draft creation with context ──────────────────────────────────────────────

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

// Only substantive own messages become style candidates.
function isUsableStyleCandidate(content) {
  const text = String(content || '').trim();
  if (text.length < 15 || text.length > 2000) return false;
  if (/^<gif|^<image/i.test(text)) return false;
  return true;
}
