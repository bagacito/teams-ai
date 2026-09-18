import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIngestionPipeline } from '../src/pipeline/ingest.js';
import { makeCtx, ingest, seed, CHAT1 } from './helpers.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Build a debounced pipeline on top of a standard test ctx, reusing its repos,
// fake notifier, and late-binding generate.
function makeDebounced(ctx, debounceMs = 60) {
  ctx.pipeline = createIngestionPipeline({
    eventRepo: ctx.repos.eventRepo,
    userRepo: ctx.repos.userRepo,
    chatRepo: ctx.repos.chatRepo,
    messageRepo: ctx.repos.messageRepo,
    draftRepo: ctx.repos.draftRepo,
    summaryRepo: ctx.repos.summaryRepo,
    styleRepo: ctx.repos.styleRepo,
    settingsRepo: ctx.repos.settingsRepo,
    notifier: ctx.notifier,
    myUserId: 'me-user-id',
    myEmail: 'me@company.com',
    generate: (args) => ctx.generate(args),
    debounceMs,
  });
  return ctx;
}

test('split messages: debounce drafts ONE response covering all fragments', async () => {
  const ctx = makeDebounced(makeCtx());
  seed(ctx, { aliceAllowed: true });

  const r1 = await ingest(ctx, { content: 'Can you review my PR?' });
  assert.equal(r1.processed, false);
  assert.equal(r1.reason, 'draft-scheduled');
  assert.equal(ctx.repos.draftRepo.listByStatus('pending').length, 0);

  // Second fragment arrives before the quiet period elapses.
  const r2 = await ingest(ctx, { eventId: 'evt-x', messageId: 'msg-x', content: 'It is the auth branch, two commits.' });
  assert.equal(r2.reason, 'draft-scheduled');
  assert.equal(ctx.repos.draftRepo.listByStatus('pending').length, 0);

  await sleep(120);

  const drafts = ctx.repos.draftRepo.listByStatus('pending');
  assert.equal(drafts.length, 1); // ONE draft, not one per message
  // The draft context saw BOTH fragments: incoming is the newest, history
  // contains the earlier one.
  assert.equal(ctx.lastContext.incomingMessage.content, 'It is the auth branch, two commits.');
  assert.ok(
    ctx.lastContext.recentMessages.some((m) => m.content === 'Can you review my PR?'),
    'earlier fragment must be in the draft context',
  );
  assert.equal(ctx.notifications.length, 1);
});

test('acknowledgment during the debounce window does not trigger its own draft', async () => {
  const ctx = makeDebounced(makeCtx());
  seed(ctx, { aliceAllowed: true });

  await ingest(ctx, { content: 'Can you review my PR?' });
  const ack = await ingest(ctx, { eventId: 'evt-2', messageId: 'msg-2', content: 'thanks' });
  assert.equal(ack.processed, false);
  assert.equal(ack.reason, 'non-response-content');

  await sleep(120);
  assert.equal(ctx.repos.draftRepo.listByStatus('pending').length, 1);
});

test('pending draft is superseded by newer messages; replacement covers them', async () => {
  const ctx = makeDebounced(makeCtx());
  seed(ctx, { aliceAllowed: true });

  // An old pending draft exists that does not know about the incoming message.
  ctx.repos.draftRepo.create({
    chatId: CHAT1,
    sourceMessageId: 'old-msg',
    senderId: 'alice-user-id',
    senderName: 'Alice',
    originalMessage: 'old question',
    generatedReply: 'old reply',
  });

  const r = await ingest(ctx, { messageId: 'new-msg', content: 'Actually, forget the PR — deploy the hotfix instead.' });
  assert.equal(r.reason, 'draft-scheduled');
  // Old draft is still pending until the replacement exists.
  assert.equal(ctx.repos.draftRepo.listByStatus('pending').length, 1);

  await sleep(120);
  const drafts = ctx.repos.draftRepo.listByStatus('pending');
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].source_message_id, 'new-msg');
  const old = ctx.repos.draftRepo.listByStatus('superseded');
  assert.equal(old.length, 1);
  assert.match(old[0].error, /superseded/);
});

test('edited draft is never superseded; no new draft while user handles it', async () => {
  const ctx = makeDebounced(makeCtx());
  seed(ctx, { aliceAllowed: true });

  const draft = ctx.repos.draftRepo.create({
    chatId: CHAT1,
    sourceMessageId: 'old-msg',
    senderId: 'alice-user-id',
    senderName: 'Alice',
    originalMessage: 'old question',
    generatedReply: 'old reply',
  });
  ctx.repos.draftRepo.applyEdit(draft.id, 'user revised text');

  const r = await ingest(ctx, { content: 'One more thing — the deadline moved to Friday.' });
  assert.equal(r.reason, 'active-draft-exists');

  await sleep(120);
  assert.equal(ctx.repos.draftRepo.listByStatus('pending').length, 0);
  assert.equal(ctx.repos.draftRepo.get(draft.id).status, 'edited'); // untouched
  assert.equal(ctx.notifications.length, 0);
});

test('user approving the pending draft before the flush prevents a duplicate', async () => {
  const ctx = makeDebounced(makeCtx());
  seed(ctx, { aliceAllowed: true });

  const draft = ctx.repos.draftRepo.create({
    chatId: CHAT1,
    sourceMessageId: 'old-msg',
    senderId: 'alice-user-id',
    senderName: 'Alice',
    originalMessage: 'old question',
    generatedReply: 'old reply',
  });
  // User approves while the debounce window is still open.
  ctx.repos.draftRepo.claimForSending(draft.id);
  ctx.repos.draftRepo.markSent(draft.id, { teamsMessageId: 'sent-1' });

  await ingest(ctx, { messageId: 'follow-up-msg', content: 'Follow-up to the old question.' });
  await sleep(120);
  // 'sent' is not an active status, so the flush proceeds for the follow-up —
  // but it must not resurrect or duplicate the old draft.
  const pending = ctx.repos.draftRepo.listByStatus('pending');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].source_message_id, 'follow-up-msg');
});

test('AI NO_REPLY during a flush creates no draft and notifies nobody', async () => {
  const ctx = makeDebounced(makeCtx());
  seed(ctx, { aliceAllowed: true });
  ctx.generate = async () => 'NO_REPLY';

  await ingest(ctx, { content: 'Deploy finished a few minutes ago.' });
  await sleep(120);
  assert.equal(ctx.repos.draftRepo.listByStatus('pending').length, 0);
  assert.equal(ctx.notifications.length, 0);
});

test('no debounce (immediate mode) keeps the classic one-draft-per-message flow', async () => {
  const ctx = makeCtx(); // helpers default: debounceMs 0
  seed(ctx, { aliceAllowed: true });

  const r1 = await ingest(ctx, { content: 'Can you review my PR?' });
  assert.equal(r1.processed, true);
  const r2 = await ingest(ctx, { eventId: 'evt-2', messageId: 'msg-2', content: 'It is the auth branch.' });
  assert.equal(r2.processed, true);
  assert.equal(ctx.repos.draftRepo.listByStatus('pending').length, 2);
});

// ── Already-answered safeguard ───────────────────────────────────────────────

test('poller retry does not draft for a message I already answered later', async () => {
  const ctx = makeCtx();
  seed(ctx, { aliceAllowed: true });
  // Thread as stored: their question, then my answer.
  ctx.repos.messageRepo.save({
    teamsMessageId: 'q1', chatId: CHAT1, senderId: 'alice-user-id', senderName: 'Alice',
    content: 'Can you review my PR?', isMe: false,
  });
  ctx.repos.messageRepo.save({
    teamsMessageId: 'a1', chatId: CHAT1, senderId: 'me-user-id', senderName: 'Me',
    content: 'Already reviewed it, left comments.', isMe: true,
  });
  // Retry path reprocesses the old question (no draft was ever created for it).
  const res = await ctx.pipeline.processMessage(
    {
      eventId: null, teamsMessageId: 'q1', chatId: CHAT1, senderId: 'alice-user-id',
      senderName: 'Alice', content: 'Can you review my PR?', messageType: 'message',
      replyTo: null, isMe: false, mentionsMe: false, chatName: '', timestamp: '',
    },
    { retry: true },
  );
  assert.equal(res.processed, false);
  assert.equal(res.reason, 'already-answered');
  assert.equal(ctx.repos.draftRepo.listByStatus('pending').length, 0);
});

test('debounce flush is skipped when I reply myself during the window', async () => {
  const ctx = makeDebounced(makeCtx());
  seed(ctx, { aliceAllowed: true });

  await ingest(ctx, { content: 'Can you review my PR?' });
  // I answer it myself before the quiet period elapses.
  await ingest(ctx, {
    eventId: 'evt-own', messageId: 'own-1', senderId: 'me-user-id', senderEmail: 'me@company.com',
    content: 'On it, will report back shortly.',
  });
  assert.equal(ctx.repos.draftRepo.listByStatus('pending').length, 0); // own message never drafts

  await sleep(120);
  assert.equal(ctx.repos.draftRepo.listByStatus('pending').length, 0); // flush skipped
  assert.equal(ctx.notifications.length, 0);
});
