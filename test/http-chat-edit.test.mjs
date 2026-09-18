import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHttpApp } from './helpers.js';

const PASSWORD = 'x'.repeat(20); // matches makeCtx ensureInitialized

function csrfOf(html) {
  const m = String(html).match(/name="_csrf" value="([^"]+)"/);
  assert.ok(m, 'csrf token not found in page');
  return m[1];
}

function cookieOf(res) {
  return res.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

function form(fields) {
  return new URLSearchParams(fields).toString();
}

const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

async function login(app) {
  let res = await app.inject({ method: 'GET', url: '/login' });
  assert.equal(res.statusCode, 200);
  const cookie = cookieOf(res);
  const csrf = csrfOf(res.body);
  res = await app.inject({
    method: 'POST',
    url: '/login',
    payload: form({ password: PASSWORD, _csrf: csrf }),
    headers: { ...FORM, cookie },
  });
  assert.equal(res.statusCode, 302); // redirect to /drafts
  return cookie;
}

test('edit chat route saves name + context (regression: repo key mismatch caused 500)', async () => {
  const { ctx, app } = await makeHttpApp();
  const cookie = await login(app);

  // Add a chat first.
  let res = await app.inject({ method: 'GET', url: '/chats', headers: { cookie } });
  assert.equal(res.statusCode, 200);
  let csrf = csrfOf(res.body); // rotated after login POST
  res = await app.inject({
    method: 'POST',
    url: '/chats',
    payload: form({ teams_chat_id: '19:abc@thread.v2', display_name: 'Alpha', context: '', _csrf: csrf }),
    headers: { ...FORM, cookie },
  });
  assert.equal(res.statusCode, 302);
  const chat = ctx.repos.chatRepo.getByChatId('19:abc@thread.v2');
  assert.ok(chat);

  // Edit it: this used to 500 with "Cannot read properties of undefined
  // (reading 'trim')" because the route passed zod keys (display_name) to
  // chatRepo.update, which expects displayName.
  res = await app.inject({ method: 'GET', url: `/chats/${chat.id}/edit`, headers: { cookie } });
  assert.equal(res.statusCode, 200);
  csrf = csrfOf(res.body); // rotated after the add POST
  res = await app.inject({
    method: 'POST',
    url: `/chats/${chat.id}/edit`,
    payload: form({ display_name: 'Alpha renamed', context: 'Project Alpha facts. Budget owner: Alice.', _csrf: csrf }),
    headers: { ...FORM, cookie },
  });
  assert.equal(res.statusCode, 302); // success redirect, NOT 500

  const after = ctx.repos.chatRepo.get(chat.id);
  assert.equal(after.display_name, 'Alpha renamed');
  assert.equal(after.context, 'Project Alpha facts. Budget owner: Alice.');
});
