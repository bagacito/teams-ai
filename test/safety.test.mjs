import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateDraft, buildPromptMessages } from '../src/ai/draft.js';
import { createNotifier } from '../src/notifications/notifier.js';
import { formatNotification } from '../src/notifications/ntfy.js';
import { makeCtx, graphMessage, notification, seed } from './helpers.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('safety boundary: only routes/drafts.js may import teams/send.js', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'test') continue;
        walk(full);
      } else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) {
        const text = fs.readFileSync(full, 'utf8');
        if (/teams\/send(\.js)?['"]/.test(text) && !full.includes(`${path.sep}routes${path.sep}`)) {
          offenders.push(path.relative(ROOT, full));
        }
      }
    }
  };
  walk(path.join(ROOT, 'src'));
  // server.js may only ASSIGN the send function into ctx, not call it in the pipeline.
  assert.deepEqual(offenders.filter((f) => !f.endsWith('server.js')), []);
});

test('safety boundary: server only wires send, pipeline has no send reference', () => {
  const server = fs.readFileSync(path.join(ROOT, 'src/server.js'), 'utf8');
  assert.match(server, /sendTeamsMessage = sendChatMessage/);
  // No pipeline module receives the send function.
  assert.doesNotMatch(server, /createIngestionPipeline\(\{[\s\S]*?send/i);
});

test('AI draft generation never triggers a Teams send', async () => {
  const ctx = makeCtx();
  seed(ctx, { aliceAllowed: true });
  ctx.graphMessage = graphMessage({ content: 'Can you review my PR?' });
  const before = ctx.sendCalls.length;
  await ctx.pipeline.processNotification(notification());
  assert.equal(ctx.sendCalls.length, before); // no send during ingestion
  assert.equal(ctx.notifications.length, 1); // but a notification fired
});

test('generateDraft returns plain text via mocked AI client', async () => {
  process.env.PDM_AI_BASE_URL = 'https://mock.local/v1';
  process.env.PDM_AI_API_KEY = 'test-key';
  const { getAiClient, resetAiClient } = await import('../src/ai/client.js');
  resetAiClient();
  const client = getAiClient();
  client.chat.completions.create = async (params) => {
    assert.equal(params.temperature, 0.2);
    assert.match(params.messages[0].content, /Write exactly as the user/);
    return { choices: [{ message: { content: '```s\non it\n```' } }] };
  };
  const { generateDraft } = await import('../src/ai/draft.js');
  const reply = await generateDraft({
    context: {
      styleExamples: [],
      recentMessages: [],
      incomingMessage: { senderName: 'Alice', content: 'Q?' },
    },
  });
  assert.equal(reply, 'on it'); // code fences stripped
  resetAiClient();
});

test('prompt contains all 8 context layers, history is capped', async () => {
  const ctx = makeCtx();
  const styleExamples = [{ message: 'short example msg' }];
  const recent = Array.from({ length: 50 }, (_, i) => ({
    senderName: 'A', content: `m${i}`, isMe: i % 2 === 0,
  }));
  const messages = buildPromptMessages({
    styleExamples,
    globalContext: 'GLOBAL',
    chatContext: 'CHATCTX',
    summary: 'SUMMARY',
    recentMessages: recent.slice(-20),
    incomingMessage: { senderName: 'A', content: 'QUESTION?' },
  });

  const system = messages[0].content;
  const user = messages[1].content;
  assert.match(system, /Write exactly as the user would normally write/);
  assert.match(system, /short example msg/);
  assert.match(system, /GLOBAL/);
  assert.match(user, /CHATCTX/);
  assert.match(user, /SUMMARY/);
  assert.match(user, /QUESTION\?/);
  assert.match(user, /m30/); // within last 20
  assert.doesNotMatch(user, /\bm10\b/); // older than 20 not included
});

test('notifications: minimal mode hides message contents', () => {
  const payload = formatNotification(
    { sender_name: 'Alice', original_message: 'SECRET ORIGINAL', generated_reply: 'SECRET REPLY' },
    { chatName: 'Project Alpha', detailMode: 'minimal', url: 'https://x/drafts', topic: 't', server: 'https://ntfy.sh' },
  );
  assert.match(payload.body, /Alice - Project Alpha/);
  assert.doesNotMatch(payload.body, /SECRET/);
  assert.equal(payload.click, 'https://x/drafts');
});

test('notifications: full mode includes contents and URL', () => {
  const payload = formatNotification(
    { sender_name: 'Alice', original_message: 'ORIGINAL', generated_reply: 'REPLY' },
    { chatName: 'Project Alpha', detailMode: 'full', url: 'https://x/drafts', topic: 't', server: 'https://ntfy.sh' },
  );
  assert.match(payload.body, /ORIGINAL/);
  assert.match(payload.body, /REPLY/);
  assert.match(payload.body, /https:\/\/x\/drafts/);
});

test('notifier skips when unconfigured', async () => {
  delete process.env.NTFY_URL;
  delete process.env.NTFY_TOPIC;
  const notifier = createNotifier({ provider: 'ntfy' });
  const sent = await notifier.notifyNewDraft({ id: 1, sender_name: 'A', generated_reply: 'r', original_message: 'o' });
  assert.equal(sent, false);
});
