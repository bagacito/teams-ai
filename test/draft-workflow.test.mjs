import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendApprovedDraft } from '../src/routes/drafts.js';
import { makeCtx, inboundPayload, ingest, seed, CHAT1 } from './helpers.js';

async function createPendingDraft(ctx, { content = 'Can you review my PR?' } = {}) {
  seed(ctx, { aliceAllowed: true });
  const res = await ingest(ctx, { content });
  assert.equal(res.processed, true);
  return ctx.repos.draftRepo.get(res.draftId);
}

test('approving pending draft calls outbound flow exactly once and marks sent', async () => {
  const ctx = makeCtx();
  const draft = await createPendingDraft(ctx);
  const result = await sendApprovedDraft(ctx, draft, { edited: false });
  assert.equal(result.ok, true);
  assert.equal(ctx.outboundCalls.length, 1);
  assert.equal(ctx.outboundCalls[0].chatId, CHAT1);
  assert.equal(ctx.outboundCalls[0].messageText, draft.generated_reply);
  assert.equal(ctx.outboundCalls[0].dryRun, undefined);
  const after = ctx.repos.draftRepo.get(draft.id);
  assert.equal(after.status, 'sent');
  assert.ok(after.sent_at);
  assert.ok(after.outbound_request_id);
  // Sent text is stored as my own message with the returned Teams message ID.
  assert.equal(ctx.repos.messageRepo.getById('sent-1').is_me, 1);
});

test('outbound success persists returned Teams message ID', async () => {
  const ctx = makeCtx();
  const draft = await createPendingDraft(ctx);
  await sendApprovedDraft(ctx, draft, { edited: false });
  const after = ctx.repos.draftRepo.get(draft.id);
  assert.equal(after.sent_teams_message_id, 'sent-1');
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
  assert.equal(ctx.outboundCalls.length, 1);
  assert.equal(ctx.repos.draftRepo.get(draft.id).status, 'sent');
});

test('rejected draft cannot send', async () => {
  const ctx = makeCtx();
  const draft = await createPendingDraft(ctx);
  assert.equal(ctx.repos.draftRepo.reject(draft.id), true);
  const result = await sendApprovedDraft(ctx, draft, { edited: false });
  assert.equal(result.ok, false);
  assert.equal(ctx.outboundCalls.length, 0);
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
  assert.equal(ctx.outboundCalls.length, 0);
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
  assert.equal(ctx.outboundCalls[0].messageText, editedText);
});

test('outbound 500 marks draft failed with safe error', async () => {
  const ctx = makeCtx();
  const draft = await createPendingDraft(ctx);
  ctx.outboundShouldFail = true;
  ctx.outboundFailStatus = 500;
  ctx.outboundFailError = 'flow internal error';
  const result = await sendApprovedDraft(ctx, draft, { edited: false });
  assert.equal(result.ok, false);
  const after = ctx.repos.draftRepo.get(draft.id);
  assert.equal(after.status, 'failed');
  assert.match(after.error, /flow internal error/);
  assert.equal(ctx.repos.messageRepo.getById('sent-1'), undefined); // nothing stored
  assert.equal(ctx.repos.styleRepo.count(), 0); // no style example
});

test('Retry after failure re-sends', async () => {
  const ctx = makeCtx();
  const draft = await createPendingDraft(ctx);
  ctx.outboundShouldFail = true;
  await sendApprovedDraft(ctx, draft, { edited: false });
  assert.equal(ctx.repos.draftRepo.get(draft.id).status, 'failed');
  ctx.outboundShouldFail = false;
  const result = await sendApprovedDraft(ctx, ctx.repos.draftRepo.get(draft.id), { edited: false });
  assert.equal(result.ok, true);
  assert.equal(ctx.outboundCalls.length, 2);
  assert.equal(ctx.repos.draftRepo.get(draft.id).status, 'sent');
});

test('unknown draft id cannot send', async () => {
  const ctx = makeCtx();
  const result = await sendApprovedDraft(ctx, null, { edited: false });
  assert.equal(result.ok, false);
  assert.equal(ctx.outboundCalls.length, 0);
});
