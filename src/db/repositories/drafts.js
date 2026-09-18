const ACTIVE_STATUSES = ['pending', 'edited'];

export function createDraftRepo(db) {
  const stmts = {
    insert: db.prepare(`
      INSERT INTO drafts (chat_id, source_message_id, sender_id, sender_name, original_message, generated_reply, status)
      VALUES (@chat_id, @source_message_id, @sender_id, @sender_name, @original_message, @generated_reply, 'pending')
    `),
    byId: db.prepare('SELECT * FROM drafts WHERE id = ?'),
    bySource: db.prepare(
      "SELECT * FROM drafts WHERE source_message_id = ? AND status IN ('pending','edited','sending','sent') ORDER BY id DESC LIMIT 1",
    ),
    activeForChat: db.prepare(
      "SELECT * FROM drafts WHERE chat_id = ? AND status IN ('pending','edited','sending') ORDER BY id DESC LIMIT 1",
    ),
    anyForSource: db.prepare('SELECT 1 FROM drafts WHERE source_message_id = ? LIMIT 1'),
    list: db.prepare('SELECT * FROM drafts WHERE status = ? ORDER BY created_at DESC, id DESC'),
    recent: db.prepare('SELECT * FROM drafts ORDER BY created_at DESC, id DESC LIMIT ?'),
    countByStatus: db.prepare('SELECT status, COUNT(*) AS c FROM drafts GROUP BY status'),
    setStatus: db.prepare(`
      UPDATE drafts SET
        status = @status,
        approved_at = COALESCE(@approved_at, approved_at),
        sent_at = COALESCE(@sent_at, sent_at),
        error = @error,
        edited_reply = COALESCE(@edited_reply, edited_reply),
        sent_teams_message_id = COALESCE(@teams_message_id, sent_teams_message_id)
      WHERE id = @id AND status IN (SELECT value FROM json_each(@expected))
    `),
    setEdited: db.prepare(
      "UPDATE drafts SET edited_reply = ?, status = 'edited' WHERE id = ? AND status = 'pending'",
    ),
    expireOld: db.prepare(`
      UPDATE drafts SET status = 'expired', error = 'expired without approval'
      WHERE status = 'pending' AND created_at < datetime('now', ?)
    `),
  };

  // Atomically transition a draft between states; returns true when the
  // transition happened (i.e. this caller owns the state change).
  function transition(id, fromStatuses, toFields) {
    const info = stmts.setStatus.run({
      id,
      expected: JSON.stringify(fromStatuses),
      status: toFields.status,
      approved_at: toFields.approvedAt ?? null,
      sent_at: toFields.sentAt ?? null,
      error: toFields.error ?? null,
      edited_reply: toFields.editedReply ?? null,
      teams_message_id: toFields.teamsMessageId ?? null,
    });
    return info.changes > 0;
  }

  return {
    create({ chatId, sourceMessageId, senderId, senderName, originalMessage, generatedReply }) {
      const info = stmts.insert.run({
        chat_id: chatId,
        source_message_id: sourceMessageId,
        sender_id: senderId ?? '',
        sender_name: senderName ?? '',
        original_message: originalMessage ?? '',
        generated_reply: generatedReply,
      });
      return stmts.byId.get(info.lastInsertRowid);
    },
    get(id) {
      return stmts.byId.get(id);
    },
    findActiveForSource(sourceMessageId) {
      return stmts.bySource.get(sourceMessageId);
    },
    hasDraftForSource(sourceMessageId) {
      return !!stmts.anyForSource.get(sourceMessageId);
    },
    listByStatus(status) {
      return stmts.list.all(status);
    },
    recent(limit = 50) {
      return stmts.recent.all(limit);
    },
    statusCounts() {
      return Object.fromEntries(stmts.countByStatus.all().map((r) => [r.status, r.c]));
    },
    isSendable(draft) {
      return draft && ACTIVE_STATUSES.includes(draft.status);
    },
    // claim for sending (pending|edited|failed -> sending). Idempotent guard
    // against double-send; only explicit approval/retry actions reach here.
    claimForSending(id) {
      return transition(id, [...ACTIVE_STATUSES, 'failed'], {
        status: 'sending',
      });
    },
    markSent(id, { sentAt = new Date().toISOString(), teamsMessageId = null } = {}) {
      return transition(id, ['sending'], { status: 'sent', sentAt, teamsMessageId });
    },
    markFailed(id, error) {
      return transition(id, ['sending'], { status: 'failed', error: String(error).slice(0, 500) });
    },
    // pending -> edited with the user's revised text
    applyEdit(id, editedReply) {
      return stmts.setEdited.run(editedReply, id).changes > 0;
    },
    reject(id) {
      return transition(id, ACTIVE_STATUSES, { status: 'rejected' });
    },
    findActiveForChat(chatId) {
      return stmts.activeForChat.get(chatId);
    },
    // pending -> superseded: a newer message arrived and the pending draft
    // does not cover it; a fresh draft will be generated for the whole batch.
    // 'edited' drafts are never superseded (user already worked on them).
    supersede(id) {
      return transition(id, ['pending'], {
        status: 'superseded',
        error: 'superseded: newer messages arrived in this chat',
      });
    },
    // Failed draft can be retried back into edited/pending state by re-claiming.
    expireOld(hours) {
      return stmts.expireOld.run(`-${Number(hours) || 12} hours`).changes;
    },
    finalText(draft) {
      return draft.edited_reply ?? draft.generated_reply;
    },
  };
}
