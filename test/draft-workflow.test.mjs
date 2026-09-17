import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendApprovedDraft } from '../src/routes/drafts.js';
import { makeCtx, graphMessage, notification, seed, ALICE, CHAT1 } from './helpers.js';

async function createPendingDraft(ctx, { content = 'Can you review my PR?' } = {}) {
  seed(ctx, { aliceAllowed: true });
  ctx.graphMessage = graphMessage({ content });
  const res = await ctx.pipeline.processNotification(notification());
  assert.equal(res.processed, true);
  return ctx.repos.draftRepo.get(res.draftId);
}

function flashOf(ctx) {
  return ctx.lastFlash;
}

test('approving pending draft sends exactly once and marks sent', async () => {
  const ctx = makeCtx();
  const draft = await createPendingDraft(ctx);
  const result = await sendApprovedDraft(ctx, draft, { edited: false });
  assert.equal(result.ok, true);
  assert.equal(ctx.sendCalls.length, 1);
  assert.equal(ctx.sendCalls[0].chatId, CHAT1);
  assert.equal(ctx.sendCalls[0].text, draft.generated_reply);
  const after = ctx.repos.draftRepo.get(draft.id);
  assert.equal(after.status, 'sent');
  assert.ok(after.sent_at);
  // Sent text is stored as my own message.
  assert.ok(ctx.repos.messageRepo.getById('sent-1'));
  assert.equal(ctx.repos.messageRepo.getById('sent-1').is_me, 1);
});

test('double approval does not double-send', async () => {
  const ctx = makeCtx();
  const draft = await createPendingDraft(ctx);
  const [r1, r2] = await Promise.all([
    sendApprovedDraft(ctx, draft, { edited: false }),
    sendApprovedDraft(ctx, draft, { edited: false }),
  ]);
  const successes = [r1, r2].filter((r) => r.ok);
  assert.equal(successes.length, 1);
  assert.equal(ctx.sendCalls.length, 1);
  assert.equal(ctx.repos.draftRepo.get(draft.id).status, 'sent');
});

test('rejected draft cannot send', async () => {
  const ctx = makeCtx();
  const draft = await createPendingDraft(ctx);
  assert.equal(ctx.repos.draftRepo.reject(draft.id), true);
  const result = await sendApprovedDraft(ctx, draft, { edited: false });
  assert.equal(result.ok, false);
  assert.equal(ctx.sendCalls.length, 0);
});

test('expired draft cannot send', async () => {
  const ctx = makeCtx();
  const draft = await createPendingDraft(ctx);
  ctx.db.prepare("UPDATE drafts SET created_at = datetime('now', '-13 hours') WHERE id = ?").run(draft.id);
  assert.equal(ctx.repos.draftRepo.expireOld(12), 1);
  const expired = ctx.repos.draftRepo.get(draft.id);
  assert.equal(expired.status, 'expired');
  const result = await sendApprovedDraft(ctx, expired, { edited: false });
  assert.equal(result.ok, false);
  assert.equal(ctx.sendCalls.length, 0);
});

test('edited draft sends edited text', async () => {
  const ctx = makeCtx();
  const draft = await createPendingDraft(ctx);
  const editedText = 'On it, review tomorrow.';
  assert.equal(ctx.repos.draftRepo.applyEdit(draft.id, editedText), true);
  const edited = ctx.repos.draftRepo.get(draft.id);
  assert.equal(edited.status, 'edited');
  const result = await sendApprovedDraft(ctx, edited, { edited: true });
  assert.equal(result.ok, true);
  assert.equal(ctx.sendCalls[0].text, editedText);
});

test('send failure marks failed and Retry re-sends', async () => {
  const ctx = makeCtx();
  const draft = await createPendingDraft(ctx);
  // First attempt fails.
  ctx.sendTeamsMessage = async () => {
    throw new Error('graph down');
  };
  const failed = await sendApprovedDraft(ctx, draft, { edited: false });
  assert.equal(failed.ok, false);
  const after = ctx.repos.draftRepo.get(draft.id);
  assert.equal(after.status, 'failed');
  assert.match(after.error, /graph down/);
  // Retry with working sender: claim succeeds (failed -> sending allowed via retry path).
  ctx.sendTeamsMessage = async (chatId, text) => {
    ctx.sendCalls.push({ chatId, text });
    return { id: `sent-${ctx.sendCalls.length}` };
  };
  const result = await sendApprovedDraft(ctx, after, { edited: false });
  assert.equal(result.ok, true);
  assert.equal(ctx.sendCalls.length, 1);
  assert.equal(ctx.repos.draftRepo.get(draft.id).status, 'sent');
});

test('unknown draft id cannot send', async () => {
  const ctx = makeCtx();
  const result = await sendApprovedDraft(ctx, null, { edited: false });
  assert.equal(result.ok, false);
  assert.equal(ctx.sendCalls.length, 0);
});
