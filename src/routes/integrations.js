import { replyHtml, setFlash } from './guards.js';
import { esc } from '../views/layout.js';

export function registerIntegrationsRoutes(app, ctx) {
  const { draftRepo } = ctx.repos;

  const badge = (ok, okText = 'configured') =>
    ok ? `<span class="badge sent">${okText}</span>` : '<span class="badge rejected">not configured</span>';

  function teamsBadge(st) {
    if (!st) return '<span class="badge rejected">unknown</span>';
    if (st.ok && st.authenticated && !st.loginRequired) return '<span class="badge sent">Connected</span>';
    if (st.ok && st.loginRequired) return '<span class="badge expired">Login required</span>';
    if (st.ok && !st.authenticated) return '<span class="badge expired">Disconnected</span>';
    return '<span class="badge rejected">Error</span>';
  }

  async function page(req, reply) {
    const aiConfigured = !!(process.env.PDM_AI_BASE_URL && process.env.PDM_AI_API_KEY);
    const providerConfigured = !!process.env.MSTEAMS_MCP_PATH;

    // Never throw because of Teams problems — the page must stay usable.
    let providerStatus = null;
    let pollStatus = null;
    try {
      providerStatus = await ctx.teamsProvider.status();
    } catch (err) {
      providerStatus = { ok: false, authenticated: false, error: err.message };
    }
    pollStatus = ctx.poller ? ctx.poller.status() : null;
    const pendingCount =
      draftRepo.listByStatus('pending').length + draftRepo.listByStatus('edited').length;

    const lastAccess = pollStatus?.lastSuccessAt
      ? esc(pollStatus.lastSuccessAt)
      : '<span class="muted">never</span>';

    const body = `
    <h1>Integrations</h1>

    <div class="card">
      <h2>Teams provider</h2>
      <table>
        <tr><th>Component</th><th>State</th><th>Detail</th></tr>
        <tr><td>Teams provider (${esc(ctx.teamsProvider?.name ?? 'unknown')})</td>
            <td>${teamsBadge(providerStatus)}</td>
            <td class="muted">${esc(providerStatus?.error ?? '')}</td></tr>
        <tr><td>Provider CLI configured (MSTEAMS_MCP_PATH)</td><td>${badge(providerConfigured)}</td><td></td></tr>
        <tr><td>PDM.AI (base URL + API key set)</td><td>${badge(aiConfigured)}</td><td></td></tr>
      </table>
      <p class="muted">Authentication status only — session/token data is never read or displayed.</p>
    </div>

    <div class="card">
      <h2>Teams poller</h2>
      <table>
        <tr><th>Field</th><th>Value</th></tr>
        <tr><td>State</td><td>${pollStatus?.running ? '<span class="badge sent">running</span>' : '<span class="badge rejected">paused</span>'}${pollStatus?.active ? ' <span class="badge pending">polling now</span>' : ''}</td></tr>
        <tr><td>Interval</td><td>${esc(String(pollStatus?.intervalSeconds ?? '—'))}s</td></tr>
        <tr><td>Last poll</td><td>${pollStatus?.lastPollAt ? esc(pollStatus.lastPollAt) : '<span class="muted">never</span>'}</td></tr>
        <tr><td>Last successful poll</td><td>${lastAccess}</td></tr>
        <tr><td>Chats scanned</td><td>${esc(String(pollStatus?.lastStats?.chatsScanned ?? 0))}</td></tr>
        <tr><td>Messages discovered</td><td>${esc(String(pollStatus?.lastStats?.messagesDiscovered ?? 0))}</td></tr>
        <tr><td>Last error</td><td class="muted">${esc(pollStatus?.lastError ?? 'none')}</td></tr>
        <tr><td>Pending drafts</td><td>${esc(String(pendingCount))}</td></tr>
      </table>
      <div class="actions">
        <form method="post" action="/integrations/poll-now" class="inline">
          <input type="hidden" name="_csrf" value="__CSRF__">
          <button class="btn primary" type="submit">Poll now</button>
        </form>
        <form method="post" action="/integrations/poll-pause" class="inline">
          <input type="hidden" name="_csrf" value="__CSRF__">
          <button class="btn" type="submit">Pause polling</button>
        </form>
        <form method="post" action="/integrations/poll-resume" class="inline">
          <input type="hidden" name="_csrf" value="__CSRF__">
          <button class="btn" type="submit">Resume polling</button>
        </form>
      </div>
      <p class="muted">Interval is set via <code>TEAMS_POLL_INTERVAL_SECONDS</code> (default 60).</p>
    </div>`;

    return replyHtml(req, reply, { title: 'Integrations', active: '/integrations', body: injectCsrf(body, req) });
  }

  app.get('/integrations', page);

  app.post('/integrations/poll-now', async (req, reply) => {
    try {
      const res = await ctx.poller.pollNow();
      if (res.skipped) {
        setFlash(req, 'A poll is already running — skipped.', 'error');
      } else if (res.ok) {
        setFlash(req, `Poll complete: ${res.stats.chatsScanned} chats scanned, ${res.stats.messagesDiscovered} new messages.`);
      } else if (res.reason === 'auth-required') {
        setFlash(req, 'Teams not authenticated — run the msteams-mcp login command (see README).', 'error');
      } else {
        setFlash(req, `Poll failed: ${res.error ?? 'provider error'}`, 'error');
      }
    } catch (err) {
      setFlash(req, `Poll failed: ${err.message}`, 'error');
    }
    return reply.redirect('/integrations');
  });

  app.post('/integrations/poll-pause', async (req, reply) => {
    ctx.poller?.pause();
    ctx.logger.info('polling paused by admin');
    setFlash(req, 'Polling paused.');
    return reply.redirect('/integrations');
  });

  app.post('/integrations/poll-resume', async (req, reply) => {
    ctx.poller?.resume();
    ctx.logger.info('polling resumed by admin');
    setFlash(req, 'Polling resumed.');
    return reply.redirect('/integrations');
  });
}

function injectCsrf(html, req) {
  return html.replaceAll('__CSRF__', req.session?.get('csrfToken') ?? '');
}
