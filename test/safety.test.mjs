import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateDraft } from '../src/ai/draft.js';
import { createNotifier } from '../src/notifications/notifier.js';
import { formatNotification } from '../src/notifications/ntfy.js';
import { makeCtx, seed, ingest } from './helpers.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function readSrcFiles() {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        walk(full);
      } else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) {
        files.push({ rel: path.relative(ROOT, full), full, text: fs.readFileSync(full, 'utf8') });
      }
    }
  };
  walk(path.join(ROOT, 'src'));
  return files;
}

test('safety boundary: ctx.sendTeamsMessage is only wired in server.js and consumed in routes/drafts.js', () => {
  for (const f of readSrcFiles()) {
    const usesSend = /sendTeamsMessage/.test(f.text);
    const allowed = ['src/server.js', 'src/routes/drafts.js'].includes(f.rel);
    if (usesSend && !allowed) {
      assert.fail(`${f.rel} references sendTeamsMessage; only server.js (wiring) and routes/drafts.js (approval) may`);
    }
  }
});

test('safety boundary: provider sendMessage is never called outside the provider boundary', () => {
  for (const f of readSrcFiles()) {
    // Provider modules and the interface may define/invoke sendMessage; the
    // application must go through ctx.sendTeamsMessage instead.
    if (f.rel.startsWith('src/teams/')) continue;
    const callsSendMessage = /\.sendMessage\(/.test(f.text);
    const definesProvider = /createTeamsProvider|createMsTeamsMcpProvider/.test(f.text) && f.rel === 'src/server.js';
    if (callsSendMessage && !definesProvider && f.rel !== 'src/server.js') {
      assert.fail(`${f.rel} calls .sendMessage() directly; use ctx.sendTeamsMessage`);
    }
  }
});

test('safety boundary: AI module and pipeline have no Teams send capability', () => {
  const pipeline = fs.readFileSync(path.join(ROOT, 'src/pipeline/ingest.js'), 'utf8');
  assert.doesNotMatch(pipeline, /sendMessage|sendTeamsMessage|teamsProvider|provider\.js/);
  for (const name of ['src/ai/draft.js', 'src/ai/client.js', 'src/ai/prompt.js', 'src/ai/style.js']) {
    const text = fs.readFileSync(path.join(ROOT, name), 'utf8');
    assert.doesNotMatch(text, /sendMessage|sendTeamsMessage|teamsProvider/, name);
  }
});

test('safety boundary: poller never sends to Teams', () => {
  const poller = fs.readFileSync(path.join(ROOT, 'src/teams/poller.js'), 'utf8');
  assert.doesNotMatch(poller, /sendMessage\(/);
  // The poller receives the provider but the interface docs forbid send use.
  assert.match(poller, /SAFETY/);
});

test('safety boundary: server wires the send path into ctx exactly once, pipeline gets no sender', () => {
  const server = fs.readFileSync(path.join(ROOT, 'src/server.js'), 'utf8');
  assert.match(server, /sendTeamsMessage/);
  assert.match(server, /teamsProvider\.sendMessage/);
  assert.doesNotMatch(server, /createIngestionPipeline\(\{[\s\S]*?send/i);
  const pipeline = fs.readFileSync(path.join(ROOT, 'src/pipeline/ingest.js'), 'utf8');
  assert.doesNotMatch(pipeline, /sendTeamsMessage|sendMessage/);
});

test('AI draft generation never triggers a Teams send', async () => {
  const ctx = makeCtx();
  seed(ctx, { aliceAllowed: true });
  const before = ctx.teamsSends.length;
  await ingest(ctx);
  assert.equal(ctx.teamsSends.length, before); // no send during ingestion
  assert.equal(ctx.notifications.length, 1); // but a notification fired
});

test('generateDraft returns plain text via mocked AI endpoint', async () => {
  process.env.PDM_AI_BASE_URL = 'https://mock.local/v1';
  process.env.PDM_AI_API_KEY = 'test-key';
  const calls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), body: JSON.parse(opts.body) });
    return new Response(JSON.stringify({ choices: [{ message: { content: '```s\non it\n```' } }] }), { status: 200 });
  };
  try {
    const reply = await generateDraft({
      context: {
        styleExamples: [],
        recentMessages: [],
        incomingMessage: { senderName: 'Alice', content: 'Q?' },
      },
    });
    assert.equal(reply, 'on it'); // code fences stripped
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.endsWith('/chat/completions'));
    assert.equal(calls[0].body.temperature, 0.2);
    assert.match(calls[0].body.messages[0].content, /Write exactly as the user/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('completeChat throws on non-2xx and non-JSON bodies', async () => {
  process.env.PDM_AI_BASE_URL = 'https://mock.local/v1';
  process.env.PDM_AI_API_KEY = 'test-key';
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('{"error":{"message":"boom"}}', { status: 502 });
    const client = await import('../src/ai/client.js');
    await assert.rejects(
      () => client.completeChat({ messages: [{ role: 'user', content: 'x' }] }),
      /502/,
    );
    // Router quirk: 200 WITHOUT Content-Type — raw body must still be parsed.
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
    const reply = await client.completeChat({ messages: [{ role: 'user', content: 'x' }] });
    assert.equal(reply, 'ok');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('prompt contains all 8 context layers, history is capped', async () => {
  const recent = Array.from({ length: 50 }, (_, i) => ({
    senderName: 'A', content: `m${i}`, isMe: i % 2 === 0,
  }));
  const messages = (await import('../src/ai/draft.js')).buildPromptMessages({
    styleExamples: [{ message: 'short example msg' }],
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
