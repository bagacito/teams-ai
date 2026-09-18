import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncStyleFromChats } from '../src/context/style-sync.js';
import { makeCtx, providerMessage, CHAT1, CHAT2, ME } from './helpers.js';

function ownMessage(overrides = {}) {
  return providerMessage({
    senderId: ME,
    senderEmail: 'me@company.com',
    isFromMe: true,
    ...overrides,
  });
}

test('sync adds own substantive messages from enabled chats as teams examples', async () => {
  const ctx = makeCtx();
  ctx.repos.chatRepo.add(CHAT1, 'Project Alpha', '');
  ctx.teamsProvider.messages = {
    [CHAT1]: [
      ownMessage({ id: 'm1', content: 'Sure, I will check the deployment logs and report back shortly.' }),
      ownMessage({ id: 'm2', content: 'The fix is on the main branch now; staging picks it up tonight.' }),
      providerMessage({ id: 'm3', content: 'Can you review my PR?' }), // not mine
      ownMessage({ id: 'm4', content: 'ok!' }), // too short
    ],
  };
  const res = await syncStyleFromChats(ctx);
  assert.equal(res.added, 2);
  assert.equal(res.candidates, 2);
  const examples = ctx.repos.styleRepo.list();
  assert.equal(examples.length, 2);
  assert.ok(examples.every((e) => e.source === 'teams' && e.source_chat_id === CHAT1));
});

test('sync is idempotent: second run adds nothing (dedupe)', async () => {
  const ctx = makeCtx();
  ctx.repos.chatRepo.add(CHAT1, 'Project Alpha', '');
  ctx.teamsProvider.messages = {
    [CHAT1]: [ownMessage({ content: 'Sure, I will check the deployment logs and report back shortly.' })],
  };
  const first = await syncStyleFromChats(ctx);
  assert.equal(first.added, 1);
  const second = await syncStyleFromChats(ctx);
  assert.equal(second.added, 0);
  assert.equal(second.duplicates, 1);
  assert.equal(ctx.repos.styleRepo.count(), 1);
});

test('sync only scans enabled chats and reports provider failures', async () => {
  const ctx = makeCtx();
  ctx.repos.chatRepo.add(CHAT1, 'Project Alpha', '');
  ctx.repos.chatRepo.add(CHAT2, 'Group Chat', '');
  ctx.repos.chatRepo.setEnabled(ctx.repos.chatRepo.getByChatId(CHAT2).id, false);
  ctx.teamsProvider.messages = {
    [CHAT1]: [ownMessage({ content: 'Sure, I will check the deployment logs and report back shortly.' })],
  };
  ctx.teamsProvider.getMessagesFn = (chatId) => {
    if (chatId === CHAT2) return { ok: true, messages: [ownMessage({ content: 'from disabled chat, long enough text.' })] };
    return { ok: true, messages: ctx.teamsProvider.messages[chatId] ?? [] };
  };
  const res = await syncStyleFromChats(ctx);
  assert.equal(res.chatsTotal, 1); // disabled chat excluded
  assert.equal(res.added, 1);

  // Provider failure on the only enabled chat: counted, nothing added.
  ctx.teamsProvider.getMessagesFn = () => ({ ok: false, error: 'boom', errorType: 'PROVIDER_ERROR' });
  const failed = await syncStyleFromChats(ctx);
  assert.equal(failed.chatsFailed, 1);
  assert.equal(failed.authRequired, false);
  assert.equal(failed.added, 0);
});

test('sync flags auth-required so the UI can tell the user to log in', async () => {
  const ctx = makeCtx();
  ctx.repos.chatRepo.add(CHAT1, 'Project Alpha', '');
  ctx.teamsProvider.getMessagesFn = () => ({ ok: false, error: 'login required', errorType: 'AUTH_REQUIRED' });
  const res = await syncStyleFromChats(ctx);
  assert.equal(res.authRequired, true);
  assert.equal(res.chatsFailed, 1);
  assert.equal(ctx.repos.styleRepo.count(), 0);
});

test('no enabled chats: sync is a no-op', async () => {
  const ctx = makeCtx();
  const res = await syncStyleFromChats(ctx);
  assert.equal(res.chatsTotal, 0);
  assert.equal(res.added, 0);
});

test('edited chat context reaches draft generation as chatContext', async () => {
  const ctx = makeCtx();
  ctx.repos.chatRepo.add(CHAT1, 'Project Alpha', 'Project Alpha. Budget owner: Alice.');
  ctx.repos.userRepo.add('alice-user-id', 'Alice');
  const res = await ctx.pipeline.processMessage(
    {
      eventId: 'evt-1', teamsMessageId: 'msg-1', chatId: CHAT1,
      senderId: 'alice-user-id', senderName: 'Alice', content: 'Can you review my PR?',
      messageType: 'message', replyTo: null, isMe: false, mentionsMe: false,
      chatName: 'Project Alpha', timestamp: '2026-09-17T15:00:00Z',
    },
    { eventId: 'evt-1' },
  );
  assert.equal(res.processed, true);
  assert.equal(ctx.lastContext.chatContext, 'Project Alpha. Budget owner: Alice.');
});
