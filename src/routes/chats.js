import { z } from 'zod';
import { replyHtml, setFlash } from './guards.js';
import { esc } from '../views/layout.js';
import { ensureSubscriptions } from '../teams/subscriptions.js';

const addChatSchema = z.object({
  teams_chat_id: z.string().trim().min(1).max(300),
  display_name: z.string().trim().max(200).default(''),
  context: z.string().max(5000).default(''),
});

export function registerChatRoutes(app, ctx) {
  const { chatRepo, subRepo } = ctx.repos;

  app.get('/chats', async (req, reply) => {
    const chats = chatRepo.list();
    const rows = chats
      .map((c) => {
        const sub = subRepo.getByChatId(c.teams_chat_id);
        const subInfo = sub
          ? `<span class="badge ${sub.status === 'active' ? 'sent' : 'rejected'}">${esc(sub.status)}</span> <span class="muted">until ${esc(sub.expires_at)}</span>`
          : '<span class="muted">no subscription</span>';
        return `<tr>
        <td>${esc(c.display_name || c.teams_chat_id)}<div class="muted">${esc(c.teams_chat_id)}</div></td>
        <td>${esc(short(c.context, 80))}</td>
        <td>${c.enabled ? '<span class="badge sent">enabled</span>' : '<span class="badge rejected">disabled</span>'}</td>
        <td>${subInfo}</td>
        <td class="row-actions">
          <form method="post" action="/chats/${c.id}/toggle" class="inline">
            <input type="hidden" name="_csrf" value="__CSRF__">
            <button class="btn small" type="submit">${c.enabled ? 'Disable' : 'Enable'}</button>
          </form>
          <form method="post" action="/chats/${c.id}/delete" class="inline">
            <input type="hidden" name="_csrf" value="__CSRF__">
            <button class="btn small bad" type="submit">Remove</button>
          </form>
        </td>
      </tr>`;
      })
      .join('');

    const body = `
    <h1>Allowed chats</h1>
    <div class="card">
      <p class="muted">Every message in an enabled chat is eligible — regardless of who writes it.</p>
      <table>
        <tr><th>Chat</th><th>Context</th><th>Status</th><th>Subscription</th><th></th></tr>
        ${rows || '<tr><td colspan="5" class="muted">No chats yet.</td></tr>'}
      </table>
    </div>
    <div class="card">
      <h2>Add chat</h2>
      <form method="post" action="/chats">
        <input type="hidden" name="_csrf" value="__CSRF__">
        <label for="teams_chat_id">Teams chat ID (from Graph, e.g. 19:abc@thread.v2)</label>
        <input type="text" id="teams_chat_id" name="teams_chat_id" required>
        <label for="display_name">Friendly name</label>
        <input type="text" id="display_name" name="display_name">
        <label for="context">Custom context for this chat (extra instructions for the AI)</label>
        <textarea id="context" name="context" rows="4" placeholder="e.g. Project Alpha discussions. Budget owner: Alice. Never discuss pricing here."></textarea>
        <div class="actions"><button class="btn primary" type="submit">Add chat</button></div>
      </form>
    </div>`;
    return replyHtml(req, reply, { title: 'Chats', active: '/chats', body: injectCsrf(body, req) });
  });

  app.post('/chats', async (req, reply) => {
    const parsed = addChatSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      setFlash(req, `Invalid input: ${parsed.error.issues[0]?.message}`, 'error');
      return reply.redirect('/chats');
    }
    if (chatRepo.getByChatId(parsed.data.teams_chat_id)) {
      setFlash(req, 'Chat already added.', 'error');
      return reply.redirect('/chats');
    }
    const chat = chatRepo.add(parsed.data.teams_chat_id, parsed.data.display_name, parsed.data.context);
    ctx.logger.info({ chatId: chat.teams_chat_id }, 'allowed chat added');
    // Try to create a Graph subscription right away.
    try {
      await ensureSubscriptions({ chatRepo, subRepo });
      setFlash(req, 'Chat added. Subscription created if Graph is reachable.');
    } catch (err) {
      setFlash(req, 'Chat added, but subscription creation failed. Check /subscriptions.', 'error');
    }
    return reply.redirect('/chats');
  });

  app.post('/chats/:id/toggle', async (req, reply) => {
    const chat = chatRepo.get(Number(req.params.id));
    if (chat) {
      chatRepo.setEnabled(chat.id, !chat.enabled);
      ctx.logger.info({ chatId: chat.teams_chat_id, enabled: !chat.enabled }, 'allowed chat toggled');
    }
    return reply.redirect('/chats');
  });

  app.post('/chats/:id/delete', async (req, reply) => {
    const chat = chatRepo.get(Number(req.params.id));
    if (chat) {
      chatRepo.remove(chat.id);
      ctx.logger.info({ chatId: chat.teams_chat_id }, 'allowed chat removed');
    }
    return reply.redirect('/chats');
  });
}

function short(text, n) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function injectCsrf(html, req) {
  return html.replaceAll('__CSRF__', req.session?.get('csrfToken') ?? '');
}
