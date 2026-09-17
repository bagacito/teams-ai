import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeCtx, seed, seedPoller, providerMessage, makeRecord,
  ALICE, ME, ME_EMAIL, CHAT1, CHAT2,
} from './helpers.js';

async function pollOnce(ctx) {
  const poller = ctx.createPollerForCtx();
  const res = await poller.pollNow();
  return { poller, res };
}

test('polling unchanged chat fetches no unnecessary history', async () => {
  const ctx = makeCtx();
  seed(ctx, { aliceAllowed: true });
  seedPoller(ctx);
  const { poller } = await pollOnce(ctx); // first poll stores cursor
  assert.equal(ctx.teamsProvider.calls.getMessages[CHAT1], 1);

  await poller.pollNow(); // second poll: chat unchanged
  assert.equal(ctx.teamsProvider.calls.getMessages[CHAT1], 1); // no refetch
  assert.equal(ctx.repos.messageRepo.countForChat(CHAT1), 1);
});

test('new Teams message is stored and generates a pending draft for approved sender', async () => {
  const ctx = makeCtx();
  seed(ctx, { aliceAllowed: true });
  seedPoller(ctx);
  const { res } = await pollOnce(ctx);
  assert.equal(res.ok, true);
  assert.equal(ctx.repos.messageRepo.countForChat(CHAT1), 1);
  assert.equal(ctx.notifications.length, 1);
  const drafts = ctx.repos.draftRepo.listByStatus('pending');
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].sender_name, 'Alice');
});

test('new message in approved group chat generates a draft (any participant)', async () => {
  const ctx = makeCtx();
  ctx.repos.chatRepo.add(CHAT2, 'Group Chat');
  ctx.teamsProvider.chats = [
    { id: CHAT2, title: 'Group Chat', type: 'chat', participants: ['bob-id'], lastMessage: { senderName: 'Bob', content: 'When is the demo?', timestamp: '2026-09-17T16:00:00Z', id: 'm-g1' } },
  ];
  ctx.teamsProvider.messages = {
    [CHAT2]: [providerMessage({ id: 'm-g1', chatId: CHAT2, senderId: 'bob-id', senderName: 'Bob', content: 'When is the demo?' })],
  };
  const { res } = await pollOnce(ctx);
  assert.equal(res.ok, true);
  assert.equal(ctx.repos.draftRepo.listByStatus('pending').length, 1);
});

test('unapproved user/chat is never fetched and does not generate a draft', async () => {
  const ctx = makeCtx();
  seed(ctx, { aliceAllowed: false });
  seedPoller(ctx);
  const { res } = await pollOnce(ctx);
  assert.equal(res.ok, true);
  assert.equal(res.stats.chatsScanned, 0); // not relevant: no allowed chat/user/cursor
  assert.equal(ctx.repos.draftRepo.listByStatus('pending').length, 0);
  assert.equal(ctx.notifications.length, 0);
});

test('message in chat with only unapproved participants goes to AI; NO_REPLY creates no draft', async () => {
  const ctx = makeCtx();
  seed(ctx, { aliceAllowed: true });
  ctx.repos.chatRepo.add(CHAT2, 'Open Chat'); // chat allowed -> scanned
  ctx.teamsProvider.chats = [
    { id: CHAT2, title: 'Open Chat', type: 'chat', participants: [], lastMessage: { senderName: 'Bob', content: 'FYI deploy done', timestamp: '2026-09-17T16:00:00Z', id: 'm-o1' } },
  ];
  ctx.teamsProvider.messages = {
    [CHAT2]: [providerMessage({ id: 'm-o1', chatId: CHAT2, senderId: 'bob-id', senderName: 'Bob', content: 'FYI deploy done' })],
  };
  ctx.generate = async () => 'NO_REPLY';
  const { res } = await pollOnce(ctx);
  assert.equal(res.ok, true);
  assert.equal(ctx.repos.draftRepo.listByStatus('pending').length, 0); // AI decided no reply
});

test('my own message does not generate a draft but is stored (style/history)', async () => {
  const ctx = makeCtx();
  ctx.repos.chatRepo.add(CHAT1, 'Self'); // chat allowed -> poller scans it
  ctx.teamsProvider.chats = [
    { id: CHAT1, title: 'Self', type: 'chat', participants: [ME], lastMessage: { senderName: 'Me', content: 'Sure, I will check the logs and report back soon.', timestamp: '2026-09-17T15:00:00Z', id: 'm-me' } },
  ];
  ctx.teamsProvider.messages = {
    [CHAT1]: [providerMessage({ id: 'm-me', senderId: ME, senderEmail: ME_EMAIL, senderName: 'Me', isFromMe: true, content: 'Sure, I will check the logs and report back soon.' })],
  };
  const { res } = await pollOnce(ctx);
  assert.equal(res.ok, true);
  assert.equal(ctx.repos.messageRepo.countForChat(CHAT1), 1);
  assert.equal(ctx.repos.draftRepo.listByStatus('pending').length, 0);
  assert.equal(ctx.notifications.length, 0);
  // own message captured as style candidate (capture_own_messages_style default on)
  assert.equal(ctx.repos.styleRepo.list().filter((s) => s.source === 'teams').length, 1);
});

test('duplicate Teams message is ignored (id dedupe across polls)', async () => {
  const ctx = makeCtx();
  seed(ctx, { aliceAllowed: true });
  seedPoller(ctx);
  await pollOnce(ctx);
  // Re-run pipeline with the same message id (simulating a repeat fetch).
  const res = await ctx.pipeline.processMessage(makeRecord({ eventId: 'other-event', messageId: 'msg-1' }), { eventId: 'other-event' });
  assert.equal(res.processed, false);
  assert.equal(res.reason, 'duplicate-message');
  assert.equal(ctx.notifications.length, 1);
});

test('poll failures do not stop other chats', async () => {
  const ctx = makeCtx();
  seed(ctx, { aliceAllowed: true });
  ctx.teamsProvider.chats = [
    { id: 'chat-bad', title: 'Bad', type: 'chat', participants: [ALICE], lastMessage: { senderName: 'X', content: 'q?', timestamp: '2026-09-17T15:00:00Z', id: 'mb1' } },
    { id: CHAT1, title: 'Good', type: 'chat', participants: [ALICE], lastMessage: { senderName: 'Alice', content: 'Can you review?', timestamp: '2026-09-17T15:00:00Z', id: 'mg1' } },
  ];
  ctx.teamsProvider.messages = {
    'chat-bad': [providerMessage({ id: 'mb1', chatId: 'chat-bad' })],
    [CHAT1]: [providerMessage({ id: 'mg1' })],
  };
  ctx.teamsProvider.getMessagesFn = (chatId) =>
    chatId === 'chat-bad'
      ? { ok: false, error: 'provider exploded', errorType: 'PROVIDER_ERROR' }
      : { ok: true, messages: ctx.teamsProvider.messages[chatId] };

  const { res } = await pollOnce(ctx);
  assert.equal(res.ok, true);
  assert.equal(res.stats.errors, 1);
  assert.equal(ctx.repos.messageRepo.countForChat(CHAT1), 1); // good chat processed
  assert.equal(ctx.repos.pollStateRepo.get('chat-bad').last_error, 'provider exploded');
  assert.equal(ctx.repos.draftRepo.listByStatus('pending').length, 1);
});

test('poll cursor updates after successful processing', async () => {
  const ctx = makeCtx();
  seed(ctx, { aliceAllowed: true });
  seedPoller(ctx);
  await pollOnce(ctx);
  const state = ctx.repos.pollStateRepo.get(CHAT1);
  assert.equal(state.last_message_id, 'msg-1');
  assert.equal(state.last_message_timestamp, '2026-09-17T15:00:00Z');
  assert.ok(state.last_success_at);
  assert.equal(state.last_error, null);
});

test('failed processing does not incorrectly advance the cursor', async () => {
  const ctx = makeCtx();
  seed(ctx, { aliceAllowed: true });
  ctx.teamsProvider.chats = [
    { id: CHAT1, title: 'X', type: 'chat', participants: [ALICE], lastMessage: { senderName: 'Alice', content: 'q?', timestamp: '2026-09-17T15:00:00Z', id: 'mx1' } },
  ];
  ctx.teamsProvider.messages = { [CHAT1]: [providerMessage({ id: 'mx1', content: 'q?' })] };
  // Pipeline throws mid-processing (AI generation failure after message save).
  ctx.generate = async () => {
    throw new Error('AI down');
  };
  const { res } = await pollOnce(ctx);
  assert.equal(res.ok, true);
  const state = ctx.repos.pollStateRepo.get(CHAT1);
  assert.match(state.last_error, /generation failed/);
  assert.equal(state.last_message_id, null); // cursor NOT advanced
  // Next poll retries the same message.
  delete ctx.teamsProvider.getMessagesFn;
  ctx.generate = async () => 'fixed reply';
  const res2 = await ctx.createPollerForCtx().pollNow();
  assert.equal(res2.ok, true);
  assert.equal(ctx.repos.draftRepo.listByStatus('pending').length, 1);
});

test('disconnected Teams provider does not crash the application/poller', async () => {
  const ctx = makeCtx();
  seed(ctx, { aliceAllowed: true });
  seedPoller(ctx);
  ctx.teamsProvider.statusFn = () => ({ ok: true, authenticated: false, loginRequired: true, error: 'Teams login required' });
  const { res, poller } = await pollOnce(ctx);
  assert.equal(res.reason, 'auth-required');
  const st = poller.status();
  assert.match(st.lastError, /login required|authentication/i);
  assert.equal(ctx.teamsProvider.calls.getMessages[CHAT1], undefined);
  // App still works: pipeline/draft routes untouched.
  const ingest = await ctx.pipeline.processMessage(makeRecord(), { eventId: 'evt-manual' });
  assert.equal(ingest.processed, true);
});

test('Poll Now does not overlap an active poll', async () => {
  const ctx = makeCtx();
  seed(ctx, { aliceAllowed: true });
  seedPoller(ctx);
  const poller = ctx.createPollerForCtx();
  // Hold the first poll open.
  let release;
  const gate = new Promise((r) => (release = r));
  ctx.teamsProvider.getMessagesFn = async () => {
    await gate;
    return { ok: true, messages: [] };
  };
  const first = poller.pollNow();
  await new Promise((r) => setTimeout(r, 10));
  const second = await poller.pollNow();
  assert.equal(second.skipped, true);
  assert.equal(second.reason, 'overlap');
  release();
  const firstRes = await first;
  assert.equal(firstRes.ok, true);
});

test('provider listChats failure is reported without throwing', async () => {
  const ctx = makeCtx();
  ctx.teamsProvider.listChatsError = { ok: false, error: 'cli timeout', errorType: 'PROVIDER_ERROR' };
  const { res, poller } = await pollOnce(ctx);
  assert.equal(res.ok, false);
  assert.match(poller.status().lastError, /cli timeout/);
});

test('irrelevant chats are not fetched at all', async () => {
  const ctx = makeCtx();
  seed(ctx, { aliceAllowed: true });
  ctx.teamsProvider.chats = [
    { id: 'chat-random', title: 'Random', type: 'chat', participants: ['zed-id'], lastMessage: { senderName: 'Zed', content: 'hi', timestamp: '2026-09-17T15:00:00Z', id: 'z1' } },
    { id: CHAT1, title: 'Alpha', type: 'chat', participants: [ALICE], lastMessage: { senderName: 'Alice', content: 'q?', timestamp: '2026-09-17T15:00:00Z', id: 'a1' } },
  ];
  ctx.teamsProvider.messages = { [CHAT1]: [providerMessage({ id: 'a1' })] };
  const { res } = await pollOnce(ctx);
  assert.equal(res.stats.chatsScanned, 1);
  assert.equal(ctx.teamsProvider.calls.getMessages['chat-random'], undefined);
});
