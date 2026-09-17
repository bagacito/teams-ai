import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendApprovedDraft } from '../src/routes/drafts.js';
import { makeCtx, ingest, seed, CHAT1 } from './helpers.js';

async function createPendingDraft(ctx) {
  seed(ctx, { aliceAllowed: true });
  const res = await ingest(ctx);
  return ctx.repos.draftRepo.get(res.draftId);
}

test('AI draft by itself does NOT become a style example', async () => {
  const ctx = makeCtx();
  await createPendingDraft(ctx);
  assert.equal(ctx.repos.styleRepo.count(), 0);
});

test('approving an unchanged draft adds approved_draft style example with final text', async () => {
  const ctx = makeCtx();
  const draft = await createPendingDraft(ctx);
  await sendApprovedDraft(ctx, draft, { edited: false });
  const examples = ctx.repos.styleRepo.list();
  assert.equal(examples.length, 1);
  assert.equal(examples[0].source, 'approved_draft');
  assert.equal(examples[0].message, draft.generated_reply);
  assert.equal(examples[0].source_chat_id, CHAT1);
});

test('edited draft: final edited text becomes higher-quality edited_draft example', async () => {
  const ctx = makeCtx();
  const draft = await createPendingDraft(ctx);
  ctx.repos.draftRepo.applyEdit(draft.id, 'final edited text here');
  await sendApprovedDraft(ctx, ctx.repos.draftRepo.get(draft.id), { edited: true });
  const examples = ctx.repos.styleRepo.list();
  assert.equal(examples.length, 1);
  assert.equal(examples[0].source, 'edited_draft');
  assert.equal(examples[0].message, 'final edited text here');
  // The untouched AI text never leaks into style examples.
  assert.equal(examples.some((e) => e.message === draft.generated_reply), false);
});

test('rejected draft never becomes a style example', async () => {
  const ctx = makeCtx();
  const draft = await createPendingDraft(ctx);
  ctx.repos.draftRepo.reject(draft.id);
  assert.equal(ctx.repos.styleRepo.count(), 0);
  assert.equal(ctx.repos.styleRepo.list().some((e) => e.message === draft.generated_reply), false);
});

test('failed send does not create style example', async () => {
  const ctx = makeCtx();
  const draft = await createPendingDraft(ctx);
  ctx.outboundShouldFail = true;
  await sendApprovedDraft(ctx, draft, { edited: false });
  assert.equal(ctx.repos.styleRepo.count(), 0);
});

test('style repo dedupes identical messages', async () => {
  const ctx = makeCtx();
  ctx.repos.styleRepo.add('hey, on it', 'manual');
  assert.equal(ctx.repos.styleRepo.add('hey, on it', 'manual'), null);
  assert.equal(ctx.repos.styleRepo.count(), 1);
});

test('my own sent messages become teams style candidates (substantive only)', async () => {
  const ctx = makeCtx();
  seed(ctx, { aliceAllowed: true });
  await ingest(ctx, {
    senderId: 'me-user-id', senderEmail: 'me@company.com',
    messageText: 'Sure, I will check the deployment logs and report back in ten minutes.',
  });
  const examples = ctx.repos.styleRepo.list();
  assert.equal(examples.length, 1);
  assert.equal(examples[0].source, 'teams');
  // short/emoji junk is not captured
  await ingest(ctx, { eventId: 'evt-2', messageId: 'msg-2', messageText: 'ok!' });
  assert.equal(ctx.repos.styleRepo.count(), 1);
});
