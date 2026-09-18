import { z } from 'zod';
import { replyHtml, setFlash } from './guards.js';
import { esc } from '../views/layout.js';
import { syncStyleFromChats } from '../context/style-sync.js';

const addExampleSchema = z.object({
  message: z.string().trim().min(1).max(2000),
});

const SOURCE_LABELS = {
  manual: 'manual',
  teams: 'sent by me',
  approved_draft: 'approved draft',
  edited_draft: 'edited draft',
};

export function registerStyleRoutes(app, ctx) {
  const { styleRepo } = ctx.repos;

  app.get('/style', async (req, reply) => {
    const examples = styleRepo.list();
    const rows = examples
      .map(
        (e) => `<tr>
        <td>${esc(short(e.message, 120))}<div class="muted">${esc(SOURCE_LABELS[e.source] ?? e.source)}</div></td>
        <td>${e.enabled ? '<span class="badge sent">enabled</span>' : '<span class="badge rejected">disabled</span>'}</td>
        <td class="row-actions">
          <form method="post" action="/style/${e.id}/toggle" class="inline">
            <input type="hidden" name="_csrf" value="__CSRF__">
            <button class="btn small" type="submit">${e.enabled ? 'Disable' : 'Enable'}</button>
          </form>
          <form method="post" action="/style/${e.id}/delete" class="inline">
            <input type="hidden" name="_csrf" value="__CSRF__">
            <button class="btn small bad" type="submit">Delete</button>
          </form>
        </td>
      </tr>`,
      )
      .join('');

    const body = `
    <h1>Writing style examples</h1>
    <div class="card">
      <p class="muted">These are few-shot examples of messages you actually wrote. AI-generated text only becomes an example after you approve or edit it. Rejected drafts are never used.</p>
      <div class="actions">
        <form method="post" action="/style/sync" class="inline">
          <input type="hidden" name="_csrf" value="__CSRF__">
          <button class="btn primary" type="submit">Sync style from Teams</button>
        </form>
        <span class="muted">Pulls your recent sent messages from every enabled chat and adds new ones as style examples.</span>
      </div>
      <table>
        <tr><th>Example</th><th>Status</th><th></th></tr>
        ${rows || '<tr><td colspan="3" class="muted">No examples yet — send some messages or approve drafts.</td></tr>'}
      </table>
    </div>
    <div class="card">
      <h2>Add example manually</h2>
      <form method="post" action="/style">
        <input type="hidden" name="_csrf" value="__CSRF__">
        <label for="message">A message written the way you normally write</label>
        <textarea id="message" name="message" rows="3" required></textarea>
        <div class="actions"><button class="btn primary" type="submit">Add example</button></div>
      </form>
    </div>`;
    return replyHtml(req, reply, { title: 'Style', active: '/style', body: injectCsrf(body, req) });
  });

  app.post('/style', async (req, reply) => {
    const parsed = addExampleSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      setFlash(req, 'Example text is required.', 'error');
      return reply.redirect('/style');
    }
    const added = styleRepo.add(parsed.data.message, 'manual');
    if (!added) setFlash(req, 'Identical example already exists.', 'error');
    else setFlash(req, 'Style example added.');
    return reply.redirect('/style');
  });

  app.post('/style/sync', async (req, reply) => {
    try {
      const res = await syncStyleFromChats(ctx, { limit: 200 });
      if (res.chatsTotal === 0) {
        setFlash(req, 'No enabled chats to sync from. Add chats first.', 'error');
      } else if (res.authRequired) {
        setFlash(req, 'Teams not authenticated — run the msteams-mcp login command (see README).', 'error');
      } else {
        const parts = [
          `Scanned ${res.chatsFetched}/${res.chatsTotal} chats.`,
          `Found ${res.candidates} of your messages.`,
          res.added ? `Added ${res.added} new style examples.` : 'No new examples (all already known).',
          res.chatsFailed ? `${res.chatsFailed} chats failed to fetch.` : '',
        ];
        setFlash(req, parts.filter(Boolean).join(' '), 'ok');
        ctx.logger.info({ added: res.added, chats: res.chatsFetched }, 'style sync completed');
      }
    } catch (err) {
      setFlash(req, `Style sync failed: ${err.message}`, 'error');
    }
    return reply.redirect('/style');
  });

  app.post('/style/:id/toggle', async (req, reply) => {
    const examples = styleRepo.list();
    const example = examples.find((e) => e.id === Number(req.params.id));
    if (example) styleRepo.setEnabled(example.id, !example.enabled);
    return reply.redirect('/style');
  });

  app.post('/style/:id/delete', async (req, reply) => {
    styleRepo.remove(Number(req.params.id));
    return reply.redirect('/style');
  });
}

function short(text, n) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function injectCsrf(html, req) {
  return html.replaceAll('__CSRF__', req.session?.get('csrfToken') ?? '');
}
