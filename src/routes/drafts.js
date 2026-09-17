// ─────────────────────────────────────────────────────────────────────────────
// Approval routes. This module is the ONLY code wired to TeamsProvider.
// sendMessage (via server.js: ctx.sendTeamsMessage). No other code path can
// send to Teams.
// ─────────────────────────────────────────────────────────────────────────────
import { createDraftForMessage } from '../pipeline/ingest.js';
import { summarizeChat, summaryTriggerCount } from '../context/summaries.js';
import { replyHtml, setFlash } from './guards.js';
import { esc } from '../views/layout.js';

export function registerDraftRoutes(app, ctx) {
  const { draftRepo, messageRepo, chatRepo, styleRepo, summaryRepo, settingsRepo } = ctx.repos;
  chatNameLookup = (chatId) => chatRepo.getByChatId(chatId)?.display_name;

  app.get('/drafts', async (req, reply) => {
    const pending = draftRepo.listByStatus('pending').concat(draftRepo.listByStatus('edited'));
    const others = draftRepo.recent(30).filter((d) => !['pending', 'edited'].includes(d.status));
    return replyHtml(req, reply, { title: 'Drafts', active: '/drafts', body: injectCsrf(draftsPage(pending, others), req) });
  });

  app.get('/drafts/:id/edit', async (req, reply) => {
    const draft = draftRepo.get(Number(req.params.id));
    if (!draft) return notFound(reply);
    return replyHtml(req, reply, { title: 'Edit draft', active: '/drafts', body: injectCsrf(editPage(draft), req) });
  });

  // Approve & Send (unchanged text).
  app.post('/drafts/:id/approve', async (req, reply) => {
    const draft = draftRepo.get(Number(req.params.id));
    if (!draft) return notFound(reply);
    const result = await sendApprovedDraft(ctx, draft, { edited: false });
    setFlash(req, result.message, result.ok ? 'ok' : 'error');
    return reply.redirect('/drafts');
  });

  // Save edited text and send it.
  app.post('/drafts/:id/edit', async (req, reply) => {
    const id = Number(req.params.id);
    const draft = draftRepo.get(id);
    if (!draft) return notFound(reply);
    const edited = String(req.body?.edited_reply ?? '').trim();
    if (!edited) {
      setFlash(req, 'Edited reply is empty.', 'error');
      return reply.redirect(`/drafts/${id}/edit`);
    }
    // pending|edited -> edited (atomic), then claim+send.
    if (!['pending', 'edited', 'failed'].includes(draft.status)) {
      setFlash(req, `Draft is ${draft.status}; cannot edit.`, 'error');
      return reply.redirect('/drafts');
    }
    draftRepo.applyEdit(id, edited);
    const fresh = draftRepo.get(id);
    const result = await sendApprovedDraft(ctx, fresh, { edited: true });
    setFlash(req, result.message, result.ok ? 'ok' : 'error');
    return reply.redirect('/drafts');
  });

  app.post('/drafts/:id/reject', async (req, reply) => {
    const id = Number(req.params.id);
    if (!draftRepo.reject(id)) {
      setFlash(req, `Draft #${id} is not rejectable in its current state.`, 'error');
      return reply.redirect('/drafts');
    }
    ctx.logger.info({ draftId: id }, 'draft rejected');
    setFlash(req, `Draft #${id} rejected.`);
    return reply.redirect('/drafts');
  });

  // Retry a failed send (returns draft to pending; user approves again).
  app.post('/drafts/:id/retry', async (req, reply) => {
    const id = Number(req.params.id);
    const draft = draftRepo.get(id);
    if (!draft || draft.status !== 'failed') {
      setFlash(req, 'Only failed drafts can be retried.', 'error');
      return reply.redirect('/drafts');
    }
    const result = await sendApprovedDraft(ctx, draft, { edited: draft.edited_reply != null });
    setFlash(req, result.message, result.ok ? 'ok' : 'error');
    return reply.redirect('/drafts');
  });

  // Regenerate an expired/failed draft using current conversation state.
  app.post('/drafts/:id/regenerate', async (req, reply) => {
    const old = draftRepo.get(Number(req.params.id));
    if (!old) return notFound(reply);
    if (!['expired', 'failed'].includes(old.status)) {
      setFlash(req, 'Only expired or failed drafts can be regenerated.', 'error');
      return reply.redirect('/drafts');
    }
    const sourceMsg = messageRepo.getById(old.source_message_id);
    if (!sourceMsg) {
      setFlash(req, 'Original message no longer available; cannot regenerate.', 'error');
      return reply.redirect('/drafts');
    }
    const chatRow = chatRepo.getByChatId(old.chat_id);
    const record = {
      teamsMessageId: sourceMsg.teams_message_id,
      chatId: sourceMsg.chat_id,
      senderId: sourceMsg.sender_id,
      senderName: sourceMsg.sender_name,
      content: sourceMsg.content,
      messageType: 'message',
      isMe: !!sourceMsg.is_me,
      mentionsMe: false,
    };
    const draft = await createDraftForMessage({
      record,
      chatName: chatRow?.display_name ?? old.chat_id,
      chatRow,
      settingsRepo,
      summaryRepo,
      styleRepo,
      draftRepo,
      messageRepo,
    });
    if (!draft) {
      setFlash(req, 'Regeneration failed (AI error).', 'error');
      return reply.redirect('/drafts');
    }
    ctx.logger.info({ oldDraftId: old.id, newDraftId: draft.id }, 'draft regenerated');
    setFlash(req, `New draft #${draft.id} generated.`);
    return reply.redirect('/drafts');
  });

}

// Replace CSRF placeholders emitted by card/form builders.
function injectCsrf(html, req) {
  const token = req.session?.get('csrfToken') ?? '';
  return html.replaceAll('__CSRF__', token);
}

let chatNameLookup = null;

// Atomic send pipeline. Returns { ok, message }.
export async function sendApprovedDraft(ctx, draft, { edited }) {
  if (!draft) {
    return { ok: false, message: 'Draft not found.' };
  }
  const { draftRepo, messageRepo, styleRepo } = ctx.repos;
  const draftId = draft.id;

  // 1) Atomic claim: pending|edited -> sending. Prevents double-send on
  //    double-click: the second request's claim fails.
  if (!draftRepo.claimForSending(draftId)) {
    ctx.logger.warn({ draftId }, 'send attempt on non-claimable draft');
    return { ok: false, message: `Draft #${draftId} is not sendable (state: ${draft.status}).` };
  }

  const text = draftRepo.finalText(draftRepo.get(draftId));
  if (!text || !text.trim()) {
    draftRepo.markFailed(draftId, 'empty reply text');
    return { ok: false, message: `Draft #${draftId} has empty text.` };
  }

  ctx.logger.info({ draftId, edited }, 'draft approved, sending');
  // 2) Send via the Teams provider. ctx.sendTeamsMessage is the ONLY send
  //    path and is set exclusively in server.js; tests inject a fake.
  try {
    const sourceMsg = messageRepo.getById(draft.source_message_id);
    const result = await ctx.sendTeamsMessage({
      chatId: draft.chat_id,
      replyToMessageId: sourceMsg?.reply_to ?? null,
      messageText: text,
    });
    if (!result.ok) {
      draftRepo.markFailed(draftId, result.error ?? 'teams send failed');
      ctx.logger.warn({ draftId, errorType: result.errorType }, 'message send failed');
      if (result.errorType === 'AUTH_REQUIRED') {
        return {
          ok: false,
          message: `Send failed for draft #${draftId}: Teams login required (run the msteams-mcp login command).`,
        };
      }
      return { ok: false, message: `Send failed for draft #${draftId}: ${result.error}` };
    }
    // 3) Mark sent + record as my message + style example.
    const teamsMessageId = result.teamsMessageId ?? `local-${draftId}`;
    draftRepo.markSent(draftId, { teamsMessageId });
    messageRepo.save({
      teamsMessageId,
      chatId: draft.chat_id,
      senderId: ctx.myUserId ?? '',
      senderName: 'Me',
      content: text,
      messageType: 'message',
      isMe: true,
      replyTo: sourceMsg?.reply_to ?? null,
    });
    styleRepo.add(text, edited ? 'edited_draft' : 'approved_draft', draft.chat_id);
    ctx.logger.info({ draftId, teamsMessageId }, 'message send succeeded');
    return { ok: true, message: `Reply sent to Teams (draft #${draftId}).` };
  } catch (err) {
    draftRepo.markFailed(draftId, err.message);
    ctx.logger.warn({ draftId }, 'message send failed');
    return { ok: false, message: `Send failed for draft #${draftId}: ${err.message}` };
  }
}

export async function refreshSummary(ctx, chatId) {
  const { messageRepo, summaryRepo } = ctx.repos;
  const trigger = summaryTriggerCount(settingsRepoOf(ctx));
  const count = messageRepo.countForChat(chatId);
  if (count < trigger) {
    ctx.logger.debug({ chatId, count }, 'summary not needed yet');
    return false;
  }
  const messages = messageRepo.recentForChat(chatId, Math.max(trigger, 60));
  const existing = summaryRepo.get(chatId);
  const summary = await summarizeChat({
    chatId,
    messages,
    existingSummary: existing?.summary ?? '',
  });
  if (summary) {
    const last = messages[messages.length - 1];
    summaryRepo.upsert(chatId, summary, last?.teams_message_id ?? null);
  }
  return true;
}

function settingsRepoOf(ctx) {
  return ctx.repos.settingsRepoRepo;
}

// ── Pages ────────────────────────────────────────────────────────────────────

function draftsPage(pending, others) {
  const pendingCards = pending.length
    ? pending.map((d) => draftCard(d)).join('\n')
    : '<div class="card"><p class="muted">No drafts waiting for approval.</p></div>';

  const otherRows = others
    .map(
      (d) => `<tr>
      <td>#${d.id}</td>
      <td><span class="badge ${esc(d.status)}">${esc(d.status)}</span></td>
      <td>${esc(d.sender_name)}</td>
      <td>${esc(short(d.original_message, 60))}</td>
      <td>${esc(short(draftFinalText(d), 60))}</td>
      <td>${esc(d.created_at)}</td>
      <td class="row-actions">${regenButton(d)}</td>
    </tr>`,
    )
    .join('');

  return `
  <h1>Drafts</h1>
  ${pendingCards}
  <h2>Recent history</h2>
  <div class="card">
    <table>
      <tr><th>ID</th><th>Status</th><th>From</th><th>Original</th><th>Reply</th><th>Created</th><th></th></tr>
      ${otherRows || '<tr><td colspan="7" class="muted">Nothing yet.</td></tr>'}
    </table>
  </div>`;
}

function draftCard(d) {
  const isEdited = d.edited_reply != null && d.edited_reply !== '';
  return `
  <div class="card" data-draft="${d.id}">
    <div class="meta">#${d.id} · ${esc(d.sender_name)} · ${esc(chatLabel(d))} · ${esc(d.created_at)}</div>
    <div class="msg-bubble">${esc(d.original_message)}</div>
    <div class="muted" style="margin-top:0.5rem">Suggested reply${isEdited ? ' (edited)' : ''}:</div>
    <div class="reply-bubble">${esc(isEdited ? d.edited_reply : d.generated_reply)}</div>
    <div class="actions">
      <form method="post" action="/drafts/${d.id}/approve" class="inline">
        <input type="hidden" name="_csrf" value="__CSRF__">
        <button class="btn ok" type="submit">Approve &amp; Send</button>
      </form>
      <a class="btn" href="/drafts/${d.id}/edit">Edit</a>
      <form method="post" action="/drafts/${d.id}/reject" class="inline">
        <input type="hidden" name="_csrf" value="__CSRF__">
        <button class="btn bad" type="submit">Reject</button>
      </form>
    </div>
  </div>`;
}

function editPage(d) {
  return `
  <h1>Edit draft #${d.id}</h1>
  <div class="card">
    <div class="meta">${esc(d.sender_name)} · ${esc(chatLabel(d))}</div>
    <div class="msg-bubble">${esc(d.original_message)}</div>
    <form method="post" action="/drafts/${d.id}/edit">
      <input type="hidden" name="_csrf" value="__CSRF__">
      <label for="edited_reply">Your reply (will be sent as-is)</label>
      <textarea id="edited_reply" name="edited_reply" rows="5">${esc(
        d.edited_reply ?? d.generated_reply,
      )}</textarea>
      <div class="actions">
        <button class="btn primary" type="submit">Save &amp; Send</button>
        <a class="btn" href="/drafts">Cancel</a>
      </div>
    </form>
  </div>`;
}

function regenButton(d) {
  if (!['expired', 'failed'].includes(d.status)) return '';
  return `<form method="post" action="/drafts/${d.id}/regenerate" class="inline">
    <input type="hidden" name="_csrf" value="__CSRF__">
    <button class="btn small" type="submit">Regenerate</button>
  </form>`;
}

function chatLabel(d) {
  const chat = chatNameLookup?.(d.chat_id);
  return chat || d.chat_id;
}

function draftFinalText(d) {
  return d.edited_reply ?? d.generated_reply;
}

function short(text, n) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function notFound(reply) {
  reply.code(404);
  return reply.send('Not found');
}
