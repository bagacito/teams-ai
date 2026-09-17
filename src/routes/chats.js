import { z } from 'zod';
import { replyHtml, setFlash } from './guards.js';
import { esc } from '../views/layout.js';

const addChatSchema = z.object({
  teams_chat_id: z.string().trim().min(1).max(300),
  display_name: z.string().trim().max(200).default(''),
  context: z.string().max(5000).default(''),
});

export function registerChatRoutes(app, ctx) {
  const { chatRepo } = ctx.repos;
  // In-memory result of the last discovery (never persisted).
  ctx.discoveredChats = [];

  function discoveredRows() {
    if (!ctx.discoveredChats.length) return '';
    const rows = ctx.discoveredChats
      .map((c) => {
        const known = chatRepo.getByChatId(c.id);
        const last = c.lastMessage;
        return `<tr>
        <td>${esc(c.title || '(unnamed)')}<div class="muted">${esc(c.id)}</div></td>
        <td>${esc(c.type)}</td>
        <td>${esc(c.participants.join(', '))}</td>
        <td>${last ? `${esc(last.senderName)}: ${esc(short(last.content, 60))}<div class="muted">${esc(last.timestamp)}</div>` : '<span class="muted">—</span>'}</td>
        <td class="row-actions">${
          known
            ? '<span class="muted">already added</span>'
            : `<form method="post" action="/chats/add-discovered" class="inline">
                <input type="hidden" name="_csrf" value="__CSRF__">
                <input type="hidden" name="teams_chat_id" value="${esc(c.id)}">
                <input type="hidden" name="display_name" value="${esc(c.title || '')}">
                <button class="btn small" type="submit">Add to approved chats</button>
              </form>`
        }</td>
      </tr>`;
      })
      .join('');
    return `
    <div class="card">
      <h2>Discovered Teams chats (${ctx.discoveredChats.length})</h2>
      <p class="muted">From the most recent Teams conversations via the Teams provider. Pick the ones the assistant should watch.</p>
      <table>
        <tr><th>Chat</th><th>Type</th><th>Participants</th><th>Last activity</th><th></th></tr>
        ${rows}
      </table>
    </div>`;
  }

  app.get('/chats', async (req, reply) => {
    const chats = chatRepo.list();
    const rows = chats
      .map((c) => {
        return `<tr>
        <td>${esc(c.display_name || c.teams_chat_id)}<div class="muted">${esc(c.teams_chat_id)}</div></td>
        <td>${esc(short(c.context, 80))}</td>
        <td>${c.enabled ? '<span class="badge sent">enabled</span>' : '<span class="badge rejected">disabled</span>'}</td>
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
    ${discoveredRows()}
    <div class="card">
      <div class="actions">
        <form method="post" action="/chats/discover" class="inline">
          <input type="hidden" name="_csrf" value="__CSRF__">
          <button class="btn primary" type="submit">Discover Teams chats</button>
        </form>
        <span class="muted">Lists recent conversations via the Teams provider so you can add them without copying IDs.</span>
      </div>
    </div>
    <div class="card">
      <p class="muted">Every message in an enabled chat is eligible — regardless of who writes it.</p>
      <table>
        <tr><th>Chat</th><th>Context</th><th>Status</th><th></th></tr>
        ${rows || '<tr><td colspan="4" class="muted">No chats yet.</td></tr>'}
      </table>
    </div>
    <div class="card">
      <h2>Add chat</h2>
      <form method="post" action="/chats">
        <input type="hidden" name="_csrf" value="__CSRF__">
        <label for="teams_chat_id">Teams chat ID (e.g. 19:abc@thread.v2 — use Discover above to find it)</label>
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
    setFlash(req, 'Chat added.');
    return reply.redirect('/chats');
  });

  // Chat discovery via the Teams provider (listChats). Never throws the page
  // away — failures become flash messages.
  app.post('/chats/discover', async (req, reply) => {
    try {
      const res = await ctx.teamsProvider.listChats({ limit: 50 });
      if (!res.ok) {
        ctx.discoveredChats = [];
        setFlash(
          req,
          res.errorType === 'AUTH_REQUIRED'
            ? 'Teams not authenticated — run the msteams-mcp login command (see README).'
            : `Discovery failed: ${res.error}`,
          'error',
        );
        return reply.redirect('/chats');
      }
      ctx.discoveredChats = res.chats;
      setFlash(req, `Discovered ${res.chats.length} recent chats.`);
    } catch (err) {
      setFlash(req, `Discovery failed: ${err.message}`, 'error');
    }
    return reply.redirect('/chats');
  });

  app.post('/chats/add-discovered', async (req, reply) => {
    const id = String(req.body?.teams_chat_id ?? '').trim();
    const name = String(req.body?.display_name ?? '').trim().slice(0, 200);
    if (!id) {
      setFlash(req, 'Missing chat id.', 'error');
      return reply.redirect('/chats');
    }
    if (!chatRepo.getByChatId(id)) {
      chatRepo.add(id, name, '');
      ctx.logger.info({ chatId: id }, 'allowed chat added (discovery)');
    }
    setFlash(req, 'Chat added to approved chats.');
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
