import { replyHtml, setFlash } from './guards.js';
import { esc } from '../views/layout.js';
import {
  renewDueSubscriptions,
  ensureSubscriptions,
} from '../teams/subscriptions.js';

export function registerSubscriptionRoutes(app, ctx) {
  const { subRepo, chatRepo } = ctx.repos;

  app.get('/subscriptions', async (req, reply) => {
    const subs = subRepo.list();
    const rows = subs
      .map(
        (s) => `<tr>
        <td>${esc(chatRepo.getByChatId(s.teams_chat_id)?.display_name || s.teams_chat_id)}</td>
        <td><span class="badge ${s.status === 'active' ? 'sent' : 'rejected'}">${esc(s.status)}</span></td>
        <td>${esc(s.expires_at)}</td>
        <td>${esc(s.last_renewed_at ?? '—')}</td>
        <td>${esc(s.last_error ?? '')}</td>
        <td class="row-actions">
          <form method="post" action="/subscriptions/${s.id}/renew" class="inline">
            <input type="hidden" name="_csrf" value="__CSRF__">
            <button class="btn small" type="submit">Renew</button>
          </form>
          <form method="post" action="/subscriptions/${s.id}/recreate" class="inline">
            <input type="hidden" name="_csrf" value="__CSRF__">
            <button class="btn small" type="submit">Recreate</button>
          </form>
        </td>
      </tr>`,
      )
      .join('');

    const body = `
    <h1>Subscriptions</h1>
    <div class="card">
      <p class="muted">Graph change notifications expire roughly every hour. A background worker renews them before expiry and recreates failed ones.</p>
      <table>
        <tr><th>Chat</th><th>Status</th><th>Expires</th><th>Last renewed</th><th>Error</th><th></th></tr>
        ${rows || '<tr><td colspan="6" class="muted">No subscriptions. Add an allowed chat first.</td></tr>'}
      </table>
      <div class="actions">
        <form method="post" action="/subscriptions/renew-due" class="inline">
          <input type="hidden" name="_csrf" value="__CSRF__">
          <button class="btn" type="submit">Renew due now</button>
        </form>
        <form method="post" action="/subscriptions/ensure-all" class="inline">
          <input type="hidden" name="_csrf" value="__CSRF__">
          <button class="btn" type="submit">Create missing</button>
        </form>
      </div>
    </div>`;
    return replyHtml(req, reply, {
      title: 'Subscriptions',
      active: '/subscriptions',
      body: injectCsrf(body, req),
    });
  });

  app.post('/subscriptions/:id/renew', async (req, reply) => {
    const { renewSubscription } = await import('../teams/subscriptions.js');
    const sub = subRepo.get(Number(req.params.id));
    if (!sub) {
      setFlash(req, 'Subscription not found.', 'error');
      return reply.redirect('/subscriptions');
    }
    try {
      const renewed = await renewSubscription(sub.subscription_id);
      subRepo.markRenewed(sub.id, renewed.expirationDateTime);
      setFlash(req, 'Subscription renewed.');
    } catch (err) {
      subRepo.markError(sub.id, 'error', err.message);
      setFlash(req, `Renewal failed: ${err.message}`, 'error');
    }
    return reply.redirect('/subscriptions');
  });

  app.post('/subscriptions/:id/recreate', async (req, reply) => {
    const { createSubscription, deleteSubscription } = await import('../teams/subscriptions.js');
    const sub = subRepo.get(Number(req.params.id));
    if (!sub) {
      setFlash(req, 'Subscription not found.', 'error');
      return reply.redirect('/subscriptions');
    }
    try {
      await deleteSubscription(sub.subscription_id).catch(() => {});
      const fresh = await createSubscription(sub.teams_chat_id);
      subRepo.save({
        teamsChatId: sub.teams_chat_id,
        subscriptionId: fresh.id,
        resource: fresh.resource,
        status: 'active',
        expiresAt: fresh.expirationDateTime,
      });
      setFlash(req, 'Subscription recreated.');
    } catch (err) {
      subRepo.markError(sub.id, 'error', err.message);
      setFlash(req, `Recreate failed: ${err.message}`, 'error');
    }
    return reply.redirect('/subscriptions');
  });

  app.post('/subscriptions/renew-due', async (req, reply) => {
    const results = await renewDueSubscriptions({ subRepo, renewWithinMs: 60 * 60_000 });
    setFlash(req, `Renewed/recreated ${results.filter((r) => r.ok).length}/${results.length}.`);
    return reply.redirect('/subscriptions');
  });

  app.post('/subscriptions/ensure-all', async (req, reply) => {
    const results = await ensureSubscriptions({ chatRepo, subRepo });
    const okCount = results.filter((r) => r.ok).length;
    setFlash(req, `Created/recreated ${okCount}/${results.length}.`);
    return reply.redirect('/subscriptions');
  });
}

function injectCsrf(html, req) {
  return html.replaceAll('__CSRF__', req.session?.get('csrfToken') ?? '');
}
