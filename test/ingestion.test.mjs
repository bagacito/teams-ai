import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeCtx,
  graphMessage,
  notification,
  seed,
  ME,
  ALICE,
  CHAT1,
  CHAT2,
} from './helpers.js';

function prime(ctx, overrides = {}) {
  ctx.graphMessage = graphMessage(overrides);
}

test('unapproved sender + unapproved chat => ignored, nothing stored', async () => {
  const ctx = makeCtx();
  prime(ctx);
  const res = await ctx.pipeline.processNotification(notification());
  assert.equal(res.processed, false);
  assert.equal(res.reason, 'not-allowed');
  assert.equal(ctx.repos.messageRepo.countForChat(CHAT1), 0);
  assert.equal(ctx.notifications.length, 0);
});

test('approved sender => message saved, draft generated, notification sent, NO send', async () => {
  const ctx = makeCtx();
  seed(ctx, { aliceAllowed: true });
  prime(ctx, { content: 'Can you review my PR?' });
  const res = await ctx.pipeline.processNotification(notification());
  assert.equal(res.processed, true);
  assert.ok(res.draftId);
  assert.equal(ctx.repos.messageRepo.countForChat(CHAT1), 1);
  assert.equal(ctx.notifications.length, 1);
  const draft = ctx.repos.draftRepo.get(res.draftId);
  assert.equal(draft.status, 'pending');
  assert.equal(draft.sender_id, ALICE);
  assert.equal(ctx.sendCalls.length, 0); // safety: no direct send
});

test('approved group chat => processed regardless of participant', async () => {
  const ctx = makeCtx();
  seed(ctx, { aliceAllowed: false, chatAllowed: true });
  prime(ctx, { senderId: 'random-participant', content: 'When is the deadline?' });
  const res = await ctx.pipeline.processNotification(
    notification({ chatId: CHAT2 }),
  );
  assert.equal(res.processed, true);
  assert.equal(ctx.notifications.length, 1);
  assert.equal(ctx.sendCalls.length, 0);
});

test('duplicate Teams message => ignored', async () => {
  const ctx = makeCtx();
  seed(ctx, { aliceAllowed: true });
  prime(ctx, { content: 'Question?' });
  const first = await ctx.pipeline.processNotification(notification());
  assert.equal(first.processed, true);
  const second = await ctx.pipeline.processNotification(
    notification({ eventId: 'evt-2' }), // different event, same message
  );
  assert.equal(second.processed, false);
  assert.equal(second.reason, 'duplicate-message');
  assert.equal(ctx.notifications.length, 1);
});

test('duplicate event id => ignored', async () => {
  const ctx = makeCtx();
  seed(ctx, { aliceAllowed: true });
  prime(ctx, { content: 'Question?' });
  await ctx.pipeline.processNotification(notification({ eventId: 'evt-x' }));
  const res = await ctx.pipeline.processNotification(notification({ eventId: 'evt-x' }));
  assert.equal(res.processed, false);
  assert.equal(res.reason, 'duplicate-event');
});

test('message from myself => ignored (stored for history only)', async () => {
  const ctx = makeCtx();
  seed(ctx, { aliceAllowed: true });
  prime(ctx, { senderId: ME, senderName: 'Me', content: 'On it.' });
  const res = await ctx.pipeline.processNotification(notification());
  assert.equal(res.processed, false);
  assert.equal(res.reason, 'own-message');
  assert.equal(ctx.notifications.length, 0);
  assert.equal(ctx.repos.draftRepo.listByStatus('pending').length, 0);
});

test('reaction/system message => ignored', async () => {
  const ctx = makeCtx();
  seed(ctx, { aliceAllowed: true });
  prime(ctx, { messageType: 'systemEvent', content: 'Alice joined the chat' });
  const res = await ctx.pipeline.processNotification(notification());
  assert.equal(res.processed, false);
  assert.equal(res.reason, 'unsupported-type:systemEvent');
});

test('non-response content ("thanks") => saved but no draft', async () => {
  const ctx = makeCtx();
  seed(ctx, { aliceAllowed: true });
  prime(ctx, { content: 'thanks!' });
  const res = await ctx.pipeline.processNotification(notification());
  assert.equal(res.processed, false);
  assert.equal(res.reason, 'non-response-content');
  assert.equal(ctx.repos.messageRepo.countForChat(CHAT1), 1); // still stored as history
  assert.equal(ctx.notifications.length, 0);
});

test('change notification with unsupported changeType => ignored', async () => {
  const ctx = makeCtx();
  seed(ctx, { aliceAllowed: true });
  prime(ctx, { content: 'Question?' });
  const res = await ctx.pipeline.processNotification(
    notification({ changeType: 'updated' }),
  );
  assert.equal(res.processed, false);
  assert.match(res.reason, /unsupported-change-type/);
});

test('clientState mismatch => rejected', async () => {
  const ctx = makeCtx();
  seed(ctx, { aliceAllowed: true });
  prime(ctx);
  const res = await ctx.pipeline.processNotification(notification(), { clientState: 'expected' });
  assert.equal(res.processed, false);
  assert.equal(res.reason, 'client-state-mismatch');
});
