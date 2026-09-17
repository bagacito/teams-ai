import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanContent, normalizeMessage, normalizeConversation } from '../src/teams/normalize.js';

test('cleanContent: HTML body becomes readable text with links preserved', () => {
  const html = '<div><p>Hey <b>Bob</b>, check <a href="https://example.com/docs">the docs</a> please</p><p>Thanks</p></div>';
  const text = cleanContent(html);
  assert.equal(text, 'Hey Bob, check the docs (https://example.com/docs) please\nThanks');
});

test('cleanContent: bare link kept as URL', () => {
  const html = '<p><a href="https://x.test">https://x.test</a></p>';
  assert.equal(cleanContent(html), 'https://x.test');
});

test('cleanContent: script/style removed, mentions keep visible text', () => {
  const html = '<style>body{}</style><p>ping <span itemtype="http://schema.skype.com/Mention">@Alice</span> now</p><script>evil()</script>';
  const text = cleanContent(html);
  assert.match(text, /ping @Alice now/);
  assert.doesNotMatch(text, /evil|body\{\}/);
});

test('cleanContent: unsafe href schemes dropped', () => {
  const html = '<a href="javascript:alert(1)">click</a>';
  assert.equal(cleanContent(html), 'click');
});

test('cleanContent: plain text passes through with entity decoding', () => {
  assert.equal(cleanContent('a &amp; b &lt;tag&gt;'), 'a & b <tag>');
});

test('normalizeMessage: full provider shape', () => {
  const m = normalizeMessage(
    {
      id: '1769',
      content: '<p>Can you <i>review</i>?</p>',
      sender: { mri: '8:orgid:abc', displayName: 'Alice', email: 'a@x.com' },
      timestamp: '2026-09-17T15:00:00Z',
      isFromMe: false,
      threadRootId: '1700',
      messagetype: 'RichText/Html',
    },
    '19:chat@thread.v2',
  );
  assert.equal(m.id, '1769');
  assert.equal(m.chatId, '19:chat@thread.v2');
  assert.equal(m.senderId, '8:orgid:abc');
  assert.equal(m.senderName, 'Alice');
  assert.equal(m.senderEmail, 'a@x.com');
  assert.equal(m.content, 'Can you review?');
  assert.equal(m.createdAt, '2026-09-17T15:00:00Z');
  assert.equal(m.replyToMessageId, '1700');
  assert.equal(m.isFromMe, false);
  assert.equal(m.rawType, 'RichText/Html');
});

test('normalizeMessage: URL-form sender and imdisplayname fallback', () => {
  const m = normalizeMessage(
    {
      id: '1',
      content: 'hi',
      from: 'https://teams.microsoft.com/api/chatsvc/amer/v1/users/ME/contacts/8:orgid:guid',
      imdisplayname: 'Bob',
      originalarrivaltime: '2026-09-17T15:00:00Z',
    },
    'c1',
  );
  assert.equal(m.senderId, '8:orgid:guid');
  assert.equal(m.senderName, 'Bob');
  assert.equal(m.createdAt, '2026-09-17T15:00:00Z');
});

test('normalizeMessage: messages without id are dropped', () => {
  assert.equal(normalizeMessage({ content: 'x' }, 'c1'), null);
});

test('normalizeConversation: maps list_chats entries', () => {
  const c = normalizeConversation({
    conversationId: '19:abc@thread.tacv2',
    chatType: 'oneOnOne',
    topic: 'Alice & Bob',
    members: [{ displayName: 'Alice' }, 'Bob'],
    lastMessage: { sender: { displayName: 'Alice' }, content: '<p>hey</p>', time: '2026-09-17T15:00:00Z' },
  });
  assert.equal(c.id, '19:abc@thread.tacv2');
  assert.equal(c.title, 'Alice & Bob');
  assert.equal(c.type, 'oneOnOne');
  assert.deepEqual(c.participants, ['Alice', 'Bob']);
  assert.equal(c.lastMessage.content, 'hey');
});

// ── Provider error contract (fake-backed) ────────────────────────────────────
test('fake provider sendMessage contract matches TeamsProvider convention', async () => {
  const { makeCtx } = await import('./helpers.js');
  const ctx = makeCtx();
  const ok = await ctx.teamsProvider.sendMessage('c1', 'hello');
  assert.equal(ok.ok, true);
  assert.match(ok.teamsMessageId, /^sent-/);
  ctx.teamsSendShouldFail = true;
  const fail = await ctx.teamsProvider.sendMessage('c1', 'hello');
  assert.equal(fail.ok, false);
  assert.equal(fail.teamsMessageId, null);
  assert.ok(fail.errorType);
});
