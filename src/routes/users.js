import { z } from 'zod';
import { replyHtml, setFlash } from './guards.js';
import { esc } from '../views/layout.js';

const addUserSchema = z.object({
  entra_user_id: z.string().trim().min(1).max(200),
  display_name: z.string().trim().max(200).default(''),
});

export function registerUserRoutes(app, ctx) {
  const { userRepo, messageRepo } = ctx.repos;

  // Senders actually seen in stored messages but not yet allowed. This is how
  // the admin learns about real senders without any directory-wide search.
  function knownSenders() {
    const rows = ctx.db.prepare(`
      SELECT sender_id, MAX(sender_name) AS sender_name, COUNT(*) AS messages
      FROM messages
      WHERE sender_id != '' AND is_me = 0
      GROUP BY sender_id
      ORDER BY messages DESC
      LIMIT 50
    `).all();
    return rows.filter((r) => !userRepo.getByEntraId(r.sender_id));
  }

  app.get('/users', async (req, reply) => {
    const users = userRepo.list();
    const rows = users
      .map(
        (u) => `<tr>
        <td>${esc(u.entra_user_id)}</td>
        <td>${esc(u.display_name)}</td>
        <td>${u.enabled ? '<span class="badge sent">enabled</span>' : '<span class="badge rejected">disabled</span>'}</td>
        <td class="row-actions">
          <form method="post" action="/users/${u.id}/toggle" class="inline">
            <input type="hidden" name="_csrf" value="__CSRF__">
            <button class="btn small" type="submit">${u.enabled ? 'Disable' : 'Enable'}</button>
          </form>
          <form method="post" action="/users/${u.id}/delete" class="inline">
            <input type="hidden" name="_csrf" value="__CSRF__">
            <button class="btn small bad" type="submit">Remove</button>
          </form>
        </td>
      </tr>`,
      )
      .join('');

    const known = knownSenders();
    const knownRows = known
      .map(
        (s) => `<tr>
        <td>${esc(s.sender_id)}</td>
        <td>${esc(s.sender_name)}</td>
        <td>${esc(String(s.messages))}</td>
        <td class="row-actions">
          <form method="post" action="/users/allow-known" class="inline">
            <input type="hidden" name="_csrf" value="__CSRF__">
            <input type="hidden" name="entra_user_id" value="${esc(s.sender_id)}">
            <input type="hidden" name="display_name" value="${esc(s.sender_name)}">
            <button class="btn small" type="submit">Allow</button>
          </form>
        </td>
      </tr>`,
      )
      .join('');

    const body = `
    <h1>Allowed users</h1>
    <div class="card">
      <p class="muted">Messages from these people are eligible for draft generation (when sender or chat allowlists match).</p>
      <table>
        <tr><th>Entra user ID</th><th>Name</th><th>Status</th><th></th></tr>
        ${rows || '<tr><td colspan="4" class="muted">No users yet.</td></tr>'}
      </table>
    </div>
    ${
      known.length
        ? `<div class="card">
      <h2>Known senders (seen in messages, not yet allowed)</h2>
      <table>
        <tr><th>User ID</th><th>Name</th><th>Messages</th><th></th></tr>
        ${knownRows}
      </table>
    </div>`
        : ''
    }
    <div class="card">
      <h2>Add user</h2>
      <form method="post" action="/users">
        <input type="hidden" name="_csrf" value="__CSRF__">
        <label for="entra_user_id">Entra user ID (GUID)</label>
        <input type="text" id="entra_user_id" name="entra_user_id" required>
        <label for="display_name">Label / name</label>
        <input type="text" id="display_name" name="display_name">
        <div class="actions"><button class="btn primary" type="submit">Add user</button></div>
      </form>
    </div>`;
    return replyHtml(req, reply, { title: 'Users', active: '/users', body: injectCsrf(body, req) });
  });

  app.post('/users', async (req, reply) => {
    const parsed = addUserSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      setFlash(req, `Invalid input: ${parsed.error.issues[0]?.message}`, 'error');
      return reply.redirect('/users');
    }
    if (userRepo.getByEntraId(parsed.data.entra_user_id)) {
      setFlash(req, 'User already allowed.', 'error');
      return reply.redirect('/users');
    }
    userRepo.add(parsed.data.entra_user_id, parsed.data.display_name);
    ctx.logger.info({ userId: parsed.data.entra_user_id }, 'allowed user added');
    setFlash(req, 'User added.');
    return reply.redirect('/users');
  });

  app.post('/users/allow-known', async (req, reply) => {
    const id = String(req.body?.entra_user_id ?? '').trim().slice(0, 200);
    const name = String(req.body?.display_name ?? '').trim().slice(0, 200);
    if (!id) {
      setFlash(req, 'Missing user id.', 'error');
      return reply.redirect('/users');
    }
    if (!userRepo.getByEntraId(id)) {
      userRepo.add(id, name);
      ctx.logger.info({ userId: id }, 'known sender added to allowed users');
    }
    setFlash(req, 'Sender allowed.');
    return reply.redirect('/users');
  });

  app.post('/users/:id/toggle', async (req, reply) => {
    const user = userRepo.get(Number(req.params.id));
    if (user) {
      userRepo.setEnabled(user.id, !user.enabled);
      ctx.logger.info({ userId: user.entra_user_id, enabled: !user.enabled }, 'allowed user toggled');
    }
    return reply.redirect('/users');
  });

  app.post('/users/:id/delete', async (req, reply) => {
    const user = userRepo.get(Number(req.params.id));
    if (user) {
      userRepo.remove(user.id);
      ctx.logger.info({ userId: user.entra_user_id }, 'allowed user removed');
    }
    return reply.redirect('/users');
  });
}

function injectCsrf(html, req) {
  return html.replaceAll('__CSRF__', req.session?.get('csrfToken') ?? '');
}
