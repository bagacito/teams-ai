import { logger } from '../logging.js';
import { isMessageAllowed } from '../policy/allowlist.js';
import { shouldDraft } from '../policy/should-draft.js';
import { generateDraft } from '../ai/draft.js';
import { getRecentMessages, getChatContext } from '../context/chat-context.js';
import { createDraftDebouncer } from '../context/debounce.js';

// ─────────────────────────────────────────────────────────────────────────────
// Draft ingestion pipeline.
//
// SAFETY: this pipeline creates a pending DRAFT and notifies. It stops there.
// It never sends anything to Teams and has no reference to any outbound
// sender. Sending happens only in routes/drafts.js after explicit human
// approval.
// ─────────────────────────────────────────────────────────────────────────────

// Message record derived from a validated provider message.
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
    debounceMs = Math.max(0, Number(process.env.DRAFT_DEBOUNCE_SECONDS ?? 90) * 1000),
  } = deps;

  const log = logger.child({ component: 'pipeline' });

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

  // Shared tail of draft creation: generate + notify. Returns the draft row
  // (or { noReply: true } / null). Never sends anything to Teams.
  async function draftAndNotify(record) {
    // Safeguard: if I already answered later in this thread, older messages
    // must not produce drafts (e.g. poller retries, debounce flushes).
    if (messageRepo.hasOwnMessageAfter(record.chatId, record.teamsMessageId)) {
      log.info(
        { messageId: record.teamsMessageId, chatId: record.chatId },
        'draft skipped: already answered by me later in the thread',
      );
      return { answered: true };
    }
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

    if (draft?.noReply) {
      log.info(
        { messageId: record.teamsMessageId, chatId: record.chatId },
        'no reply needed (AI decision)',
      );
      return { noReply: true };
    }
    if (!draft) {
      log.error({ messageId: record.teamsMessageId }, 'draft generation failed');
      return null;
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
    return { draft };
  }

  // Debounced mode (delayMs > 0): response-worthy messages do not draft
  // immediately. One flush per chat after a quiet period; the flush builds
  // context from the DB, so messages that arrived in the meantime are covered.
  // Exactly one open (pending/edited/sending) draft per chat: a pending draft
  // that no longer covers the newest messages is superseded and regenerated;
  // an edited draft means the user is already handling it — no new draft.
  const debouncer =
    debounceMs > 0
      ? createDraftDebouncer({
          delayMs: debounceMs,
          log,
          flush: async (chatId, record) => {
            // Re-check at flush time: if the user approved/edited/sent a draft
            // in the meantime, they are handling the conversation — do not
            // generate a second response for the same messages.
            const active = draftRepo.findActiveForChat(chatId);
            if (active && active.status !== 'pending') return;
            // If the user replied themselves while the flush was waiting, the
            // messages are answered — do not supersede, do not draft.
            if (messageRepo.hasOwnMessageAfter(chatId, record.teamsMessageId)) return;
            if (active) draftRepo.supersede(active.id);
            await draftAndNotify(record);
          },
        })
      : null;

  // Processes one normalized provider record. Returns { processed, reason, draftId }.
  // retry=true (poller re-processing after a failure) allows regenerating a
  // draft for an already-stored message when no draft was ever created.
  async function processMessage(record, { eventId, retry = false } = {}) {
    const log = logger.child({ component: 'pipeline' });

    // Defensive own-message detection (provider may not have flagged it).
    record.isMe =
      record.isMe === true ||
      (myUserId && record.senderId && record.senderId === myUserId) ||
      (myEmail && record.senderEmail && record.senderEmail.toLowerCase() === myEmail.toLowerCase());

    // Deduplicate at event level (external delivery retries). Polling relies
    // on message-id dedupe + cursors instead and passes no eventId.
    if (eventId && !eventRepo.firstTimeSeen(eventId, record.teamsMessageId)) {
      log.info({ eventId }, 'duplicate event ignored');
      return { processed: false, reason: 'duplicate-event' };
    }

    // Deduplicate at message level (unique constraint + explicit check).
    // A retry may regenerate when the earlier attempt never produced a draft
    // (e.g. transient AI failure).
    const existing = messageRepo.getById(record.teamsMessageId);
    const canRegenerate =
      existing &&
      retry &&
      !record.isMe &&
      record.messageType === 'message' &&
      !draftRepo.hasDraftForSource(record.teamsMessageId);
    if (existing && !canRegenerate) {
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
    const saved = existing ? existing : messageRepo.save(record);
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

    // Build context and generate the draft — either immediately (debounce
    // disabled) or once the chat goes quiet (see debouncer above).
    if (debouncer) {
      const active = draftRepo.findActiveForChat(record.chatId);
      if (active && active.status !== 'pending') {
        return { processed: false, reason: 'active-draft-exists' };
      }
      debouncer.schedule(record.chatId, record);
      return { processed: false, reason: 'draft-scheduled' };
    }

    const result = await draftAndNotify(record);
    if (result?.answered) return { processed: false, reason: 'already-answered' };
    if (result?.noReply) return { processed: false, reason: 'ai-no-reply' };
    if (!result) return { processed: false, reason: 'generation-failed' };
    return { processed: true, draftId: result.draft.id };
  }

  return { processMessage, debouncer };
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
  // The AI may decide the conversation calls for no reply at all.
  if (/^no[_ ]?reply$/i.test(reply.trim())) {
    logger.info({ messageId: record.teamsMessageId }, 'AI decided no reply is needed');
    return { noReply: true };
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
export function isUsableStyleCandidate(content) {
  const text = String(content || '').trim();
  if (text.length < 15 || text.length > 2000) return false;
  if (/^<gif|^<image/i.test(text)) return false;
  return true;
}
