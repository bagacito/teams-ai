import { replyHtml, setFlash } from './guards.js';
import { esc } from '../views/layout.js';
import { refreshSummary } from './drafts.js';
import { summaryTriggerCount } from '../context/summaries.js';

// Settings stored in the DB (override env defaults where present).

const SETTING_KEYS = [
  ['global_context', 'Global context about you (used in every draft)', 'textarea'],
  ['recent_message_count', 'Recent messages included as context', 'number'],
  ['draft_expiry_hours', 'Hours before pending drafts expire', 'number'],
  ['summary_trigger_message_count', 'Messages in a chat before a summary is generated', 'number'],
  ['ntfy_detail_mode', 'Notification detail: minimal | full', 'text'],
];

export function registerSettingsRoutes(app, ctx) {
  const { settingsRepo, summaryRepo } = ctx.repos;

  app.get('/settings', async (req, reply) => {
    const rows = SETTING_KEYS.map(([key, label, type]) => {
      const value = settingsRepo.get(key, defaultFor(key));
      const field =
        type === 'textarea'
          ? `<textarea id="${key}" name="${key}" rows="5">${esc(value)}</textarea>`
          : `<input type="${type === 'number' ? 'number' : 'text'}" id="${key}" name="${key}" value="${esc(value)}">`;
      return `<label for="${key}">${esc(label)}</label>${field}`;
    }).join('');

    const summaries = summaryRepo
      .list()
      .map(
        (s) => `<div class="msg-bubble"><strong>${esc(s.chat_id)}</strong>
        <span class="muted">· updated ${esc(s.updated_at)}</span>
        ${esc(short(s.summary, 400))}
        <form method="post" action="/summaries/${encodeURIComponent(s.chat_id)}/refresh" class="inline" style="margin-top:0.4rem">
          <input type="hidden" name="_csrf" value="__CSRF__">
          <button class="btn small" type="submit">Refresh summary</button>
        </form></div>`,
      )
      .join('');

    const body = `
    <h1>Settings</h1>
    <div class="card">
      <form method="post" action="/settings">
        <input type="hidden" name="_csrf" value="__CSRF__">
        ${rows}
        <div class="actions"><button class="btn primary" type="submit">Save settings</button></div>
      </form>
    </div>
    <div class="card">
      <h2>Conversation summaries</h2>
      <p class="muted">Factual briefs per chat, generated automatically once a chat exceeds the message threshold. Facts only — writing style is learned separately.</p>
      ${summaries || '<p class="muted">No summaries yet.</p>'}
    </div>`;
    return replyHtml(req, reply, { title: 'Settings', active: '/settings', body: injectCsrf(body, req) });
  });

  app.post('/settings', async (req, reply) => {
    for (const [key] of SETTING_KEYS) {
      const value = req.body?.[key];
      if (value !== undefined) settingsRepo.set(key, String(value).trim());
    }
    ctx.logger.info('settings updated');
    setFlash(req, 'Settings saved.');
    return reply.redirect('/settings');
  });

  app.post('/summaries/:chatId/refresh', async (req, reply) => {
    const ok = await refreshSummary(ctx, req.params.chatId);
    setFlash(
      req,
      ok ? 'Summary refreshed.' : `Not enough messages yet (threshold: ${summaryTriggerCount(settingsRepo)}).`,
      ok ? 'ok' : 'error',
    );
    return reply.redirect('/settings');
  });
}

function defaultFor(key) {
  switch (key) {
    case 'recent_message_count':
      return process.env.RECENT_MESSAGE_COUNT || 20;
    case 'draft_expiry_hours':
      return process.env.DRAFT_EXPIRY_HOURS || 12;
    case 'summary_trigger_message_count':
      return process.env.SUMMARY_TRIGGER_MESSAGE_COUNT || 40;
    case 'ntfy_detail_mode':
      return process.env.NTFY_DETAIL_MODE || 'minimal';
    default:
      return '';
  }
}

function short(text, n) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function injectCsrf(html, req) {
  return html.replaceAll('__CSRF__', req.session?.get('csrfToken') ?? '');
}
