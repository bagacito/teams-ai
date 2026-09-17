import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldDraft } from '../src/policy/should-draft.js';
import { createAllowlist, isMessageAllowed } from '../src/policy/allowlist.js';
import { makeCtx, ME, ALICE, CHAT1, CHAT2 } from './helpers.js';

test('shouldDraft: direct question => draft', () => {
  const r = shouldDraft({ messageType: 'message', content: 'Can you review the PR today?' });
  assert.equal(r.draft, true);
});

test('shouldDraft: request => draft', () => {
  const r = shouldDraft({ messageType: 'message', content: 'Could you send me the report please' });
  assert.equal(r.draft, true);
});

test('shouldDraft: mention => draft', () => {
  const r = shouldDraft({ messageType: 'message', content: 'ping', mentionsMe: true });
  assert.equal(r.draft, true);
});

test('shouldDraft: plain statement without response signal => ignored', () => {
  const r = shouldDraft({ messageType: 'message', content: 'Deploy finished a few minutes ago.' });
  assert.equal(r.draft, false);
});

test('shouldDraft: ok/thanks/greetings => ignored', () => {
  for (const text of ['ok', 'Ok!', 'thanks', 'Thank you!', 'thx', 'hello', 'Good morning']) {
    const r = shouldDraft({ messageType: 'message', content: text });
    assert.equal(r.draft, false, text);
  }
});

test('shouldDraft: emoji-only => ignored', () => {
  const r = shouldDraft({ messageType: 'message', content: '🎉🚀👍' });
  assert.equal(r.draft, false);
});

test('shouldDraft: gif/image-only => ignored', () => {
  assert.equal(shouldDraft({ messageType: 'message', content: '<gif src="x.gif">' }).draft, false);
  assert.equal(shouldDraft({ messageType: 'message', content: 'https://media.tenor.com/abc.gif' }).draft, false);
});

test('shouldDraft: empty content => ignored', () => {
  assert.equal(shouldDraft({ messageType: 'message', content: '' }).draft, false);
});

test('shouldDraft: own message => ignored', () => {
  assert.equal(shouldDraft({ messageType: 'message', content: 'Can you review?', isMe: true }).draft, false);
});

test('shouldDraft: system/reaction types => ignored', () => {
  assert.equal(shouldDraft({ messageType: 'systemEvent', content: 'added someone' }).draft, false);
  assert.equal(shouldDraft({ messageType: 'reaction', content: '👍' }).draft, false);
});

test('allowlist: approved sender allowed', () => {
  const ctx = makeCtx();
  ctx.repos.userRepo.add(ALICE, 'Alice');
  const aw = createAllowlist({ userRepo: ctx.repos.userRepo, chatRepo: ctx.repos.chatRepo, myUserId: ME });
  assert.equal(isMessageAllowed(aw, { senderId: ALICE, chatId: CHAT1 }), true);
});

test('allowlist: unapproved sender + unapproved chat rejected', () => {
  const ctx = makeCtx();
  const aw = createAllowlist({ userRepo: ctx.repos.userRepo, chatRepo: ctx.repos.chatRepo, myUserId: ME });
  assert.equal(isMessageAllowed(aw, { senderId: 'stranger', chatId: CHAT1 }), false);
});

test('allowlist: approved chat allowed regardless of participant', () => {
  const ctx = makeCtx();
  ctx.repos.chatRepo.add(CHAT2, 'Group');
  const aw = createAllowlist({ userRepo: ctx.repos.userRepo, chatRepo: ctx.repos.chatRepo, myUserId: ME });
  assert.equal(isMessageAllowed(aw, { senderId: 'anyone', chatId: CHAT2 }), true);
});

test('allowlist: disabled user/chat rejected', () => {
  const ctx = makeCtx();
  const u = ctx.repos.userRepo.add(ALICE, 'Alice');
  ctx.repos.userRepo.setEnabled(u.id, false);
  const c = ctx.repos.chatRepo.add(CHAT2, 'Group');
  ctx.repos.chatRepo.setEnabled(c.id, false);
  const aw = createAllowlist({ userRepo: ctx.repos.userRepo, chatRepo: ctx.repos.chatRepo, myUserId: ME });
  assert.equal(isMessageAllowed(aw, { senderId: ALICE, chatId: CHAT1 }), false);
  assert.equal(isMessageAllowed(aw, { senderId: 'anyone', chatId: CHAT2 }), false);
});

test('allowlist: my own user id never allowed', () => {
  const ctx = makeCtx();
  ctx.repos.userRepo.add(ME, 'Me');
  const aw = createAllowlist({ userRepo: ctx.repos.userRepo, chatRepo: ctx.repos.chatRepo, myUserId: ME });
  assert.equal(aw.isUserAllowed(ME), false);
});
