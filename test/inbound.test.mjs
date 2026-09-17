import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeCtx,
  makeHttpApp,
  inboundPayload,
  seed,
  ingest,
  ME,
  ME_EMAIL,
  ALICE,
  CHAT1,
  CHAT2,
  SECRET,
} from './helpers.js';

const PATH = '/api/power-automate/inbound';

function post(app, { body, secret = SECRET }) {
  return app.inject({
    method: 'POST',
    url: PATH,
    headers: secret ? { authorization: `Bearer ${secret}`, 'content-type': 'application/json' } : { 'content-type': 'application/json' },
    payload: body,
  });
}

test('valid inbound request => 200, draft generated, notification sent', async () => {
  const { ctx, app } = await makeHttpApp();
  seed(ctx, { aliceAllowed: true });
  const res = await post(app, { body: inboundPayload() });
  assert.equal(res.statusCode, 200);
  const json = res.json();
  assert.equal(json.accepted, true);
  assert.equal(json.processed, true);
  assert.equal(ctx.notifications.length, 1);
  const draft = ctx.repos.draftRepo.get(json.draftId ?? ctx.notifications[0]);
  assert.equal(draft.status, 'pending');
  assert.equal(draft.sender_id, ALICE);
  // message stored with all documented fields
  const msg = ctx.repos.messageRepo.getById('msg-1');
  assert.equal(msg.chat_id, CHAT1);
  assert.equal(msg.sender_id, ALICE);
  assert.equal(msg.sender_name, 'Alice');
  assert.equal(msg.content, 'Can you review my PR?');
  await app.close();
});

test('invalid secret => 401, nothing processed', async () => {
  const { ctx, app } = await makeHttpApp();
  seed(ctx, { aliceAllowed: true });
  const res = await post(app, { body: inboundPayload(), secret: 'wrong-secret' });
  assert.equal(res.statusCode, 401);
  assert.equal(ctx.notifications.length, 0);
  assert.equal(ctx.repos.messageRepo.countForChat(CHAT1), 0);
  await app.close();
});

test('missing secret => 401', async () => {
  const { app } = await makeHttpApp();
  const res = await post(app, { body: inboundPayload(), secret: null });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('malformed payload => 400', async () => {
  const { ctx, app } = await makeHttpApp();
  seed(ctx, { aliceAllowed: true });
  const res = await post(app, { body: { foo: 'bar' } });
  assert.equal(res.statusCode, 400);
  assert.equal(ctx.notifications.length, 0);
  await app.close();
});

test('missing required fields => 400', async () => {
  const { app } = await makeHttpApp();
  const p = inboundPayload();
  delete p.messageId;
  const res = await post(app, { body: p });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('duplicate eventId => no duplicate draft, still 200', async () => {
  const { ctx, app } = await makeHttpApp();
  seed(ctx, { aliceAllowed: true });
  const first = await post(app, { body: inboundPayload() });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().processed, true);
  const second = await post(app, { body: inboundPayload() }); // same eventId+messageId (retry)
  assert.equal(second.statusCode, 200);
  assert.equal(second.json().processed, false);
  assert.equal(second.json().reason, 'duplicate-event');
  assert.equal(ctx.notifications.length, 1);
  await app.close();
});

test('duplicate messageId with new eventId => no duplicate draft, still 200', async () => {
  const { ctx, app } = await makeHttpApp();
  seed(ctx, { aliceAllowed: true });
  await post(app, { body: inboundPayload() });
  const second = await post(app, { body: inboundPayload({ eventId: 'evt-2' }) });
  assert.equal(second.statusCode, 200);
  assert.equal(second.json().processed, false);
  assert.equal(second.json().reason, 'duplicate-message');
  assert.equal(ctx.notifications.length, 1);
  await app.close();
});

test('unapproved sender and chat => ignored (200), nothing stored', async () => {
  const { ctx, app } = await makeHttpApp();
  const res = await post(app, { body: inboundPayload() });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().reason, 'not-allowed');
  assert.equal(ctx.repos.messageRepo.countForChat(CHAT1), 0);
  assert.equal(ctx.notifications.length, 0);
  await app.close();
});

test('approved sender => draft generated', async () => {
  const { ctx, app } = await makeHttpApp();
  seed(ctx, { aliceAllowed: true });
  const res = await post(app, { body: inboundPayload() });
  assert.equal(res.json().processed, true);
  assert.equal(ctx.notifications.length, 1);
  await app.close();
});

test('approved group chat => draft generated regardless of participant', async () => {
  const { ctx, app } = await makeHttpApp();
  seed(ctx, { aliceAllowed: false, chatAllowed: true });
  const res = await post(app, {
    body: inboundPayload({ chatId: CHAT2, senderId: 'random-participant', messageText: 'When is the deadline?' }),
  });
  assert.equal(res.json().processed, true);
  assert.equal(ctx.notifications.length, 1);
  await app.close();
});

test('message from myself (id or email) => ignored, stored for history', async () => {
  const { ctx, app } = await makeHttpApp();
  seed(ctx, { aliceAllowed: true });
  const r1 = await post(app, { body: inboundPayload({ senderId: ME, messageText: 'On it, checking now.' }) });
  assert.equal(r1.json().reason, 'own-message');
  const r2 = await post(app, {
    body: inboundPayload({ eventId: 'evt-2', messageId: 'msg-2', senderId: 'someone-else', senderEmail: ME_EMAIL }),
  });
  assert.equal(r2.json().reason, 'own-message');
  assert.equal(ctx.notifications.length, 0);
  await app.close();
});

test('reaction/system message => ignored', async () => {
  const { ctx, app } = await makeHttpApp();
  seed(ctx, { aliceAllowed: true });
  const res = await post(app, { body: inboundPayload({ messageType: 'systemEvent', messageText: 'Alice joined' }) });
  assert.equal(res.json().reason, 'unsupported-type:systemEvent');
  await app.close();
});

test('non-response content saved as history but no draft', async () => {
  const { ctx, app } = await makeHttpApp();
  seed(ctx, { aliceAllowed: true });
  const res = await post(app, { body: inboundPayload({ messageText: 'thanks!' }) });
  assert.equal(res.json().processed, false);
  assert.equal(res.json().reason, 'non-response-content');
  assert.equal(ctx.repos.messageRepo.countForChat(CHAT1), 1);
  assert.equal(ctx.notifications.length, 0);
  await app.close();
});

test('mentionedMe => draft even without question mark', async () => {
  const { ctx, app } = await makeHttpApp();
  seed(ctx, { aliceAllowed: true });
  const res = await post(app, { body: inboundPayload({ messageText: 'ping', mentionedMe: true }) });
  assert.equal(res.json().processed, true);
  await app.close();
});

test('replyToMessageId is stored', async () => {
  const { ctx, app } = await makeHttpApp();
  seed(ctx, { aliceAllowed: true });
  await post(app, { body: inboundPayload({ replyToMessageId: 'parent-msg-1', messageText: 'Did you see my answer above?' }) });
  assert.equal(ctx.repos.messageRepo.getById('msg-1').reply_to, 'parent-msg-1');
  await app.close();
});

// Pipeline-level (non-HTTP) behavioral checks reused by other suites.
test('pipeline-level: unapproved ignored / approved processed', async () => {
  const ctx = makeCtx();
  seed(ctx, { aliceAllowed: true });
  const denied = await ingest(ctx, { senderId: 'stranger' });
  assert.equal(denied.reason, 'not-allowed');
  const allowed = await ingest(ctx, { eventId: 'evt-2' });
  assert.equal(allowed.processed, true);
  assert.equal(ctx.outboundCalls.length, 0); // ingestion never calls outbound
});
