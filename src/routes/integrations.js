import { replyHtml, setFlash } from './guards.js';
import { esc } from '../views/layout.js';
import { isOutboundConfigured } from '../integrations/power-automate/outbound.js';

export function registerIntegrationsRoutes(app, ctx) {
  const status = (ok) =>
    ok ? '<span class="badge sent">configured</span>' : '<span class="badge rejected">not configured</span>';

  const inboundConfigured = !!ctx.inboundSecret;
  const aiConfigured = !!(process.env.PDM_AI_BASE_URL && process.env.PDM_AI_API_KEY);
  const outboundOk = isOutboundConfigured();

  const base = (process.env.PUBLIC_BASE_URL || 'https://YOUR-DOMAIN').replace(/\/+$/, '');
  const sample = {
    eventId: 'pa-flow-run-00000000-0000-0000-0000-000000000000',
    messageId: '1689000000000',
    chatId: '19:abc123@thread.v2',
    chatName: 'Project Alpha',
    senderId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    senderName: 'Alice Example',
    senderEmail: 'alice@company.com',
    messageText: 'Can you review the deployment plan today?',
    messageType: 'message',
    timestamp: '2026-09-17T15:00:00Z',
    replyToMessageId: null,
    mentionedMe: false,
  };

  const body = `
  <h1>Integrations</h1>

  <div class="card">
    <h2>Status</h2>
    <table>
      <tr><th>Integration</th><th>State</th></tr>
      <tr><td>Power Automate inbound (secret set)</td><td>${status(inboundConfigured)}</td></tr>
      <tr><td>Power Automate outbound (URL + secret set)</td><td>${status(outboundOk)}</td></tr>
      <tr><td>PDM.AI (base URL + API key set)</td><td>${status(aiConfigured)}</td></tr>
    </table>
    <p class="muted">Secret values are never displayed.</p>
  </div>

  <div class="card">
    <h2>Inbound endpoint</h2>
    <p>Point your Power Automate flow's HTTP action at:</p>
    <div class="msg-bubble"><strong>POST ${esc(base)}/api/power-automate/inbound</strong><br>
    Content-Type: application/json<br>
    Authorization: Bearer &lt;POWER_AUTOMATE_INBOUND_SECRET&gt;</div>
    <p class="muted">HTTP 200 means accepted (even if the message was intentionally ignored). 400 = malformed payload, 401 = bad secret.</p>
    <h2>Sample payload</h2>
    <div class="msg-bubble"><pre style="margin:0;white-space:pre-wrap">${esc(JSON.stringify(sample, null, 2))}</pre></div>
  </div>

  <div class="card">
    <h2>Outbound flow</h2>
    <p>Set <code>POWER_AUTOMATE_OUTBOUND_URL</code> to the URL of your "send reply" flow and
    <code>POWER_AUTOMATE_OUTBOUND_SECRET</code> to its shared secret. This app posts
    <code>requestId</code>, <code>draftId</code>, <code>chatId</code>, <code>replyToMessageId</code>,
    <code>messageText</code> and expects <code>{"success": true, "teamsMessageId": "..."}</code> back.</p>
    <p class="muted">The flow must never send unless this app calls it — and this app only calls it after explicit human approval.</p>
    <form method="post" action="/integrations/test-outbound">
      <input type="hidden" name="_csrf" value="__CSRF__">
      <button class="btn" type="submit">Test outbound connection</button>
      <span class="muted">Non-destructive: sends dryRun=true, no Teams message is posted.</span>
    </form>
  </div>`;

  app.get('/integrations', async (req, reply) => {
    return replyHtml(req, reply, {
      title: 'Integrations',
      active: '/integrations',
      body: injectCsrf(body, req),
    });
  });

  app.post('/integrations/test-outbound', async (req, reply) => {
    if (!outboundOk) {
      setFlash(req, 'Outbound is not configured (POWER_AUTOMATE_OUTBOUND_URL / SECRET missing).', 'error');
      return reply.redirect('/integrations');
    }
    try {
      const result = await ctx.sendOutbound({ draftId: null, chatId: 'test', messageText: '', dryRun: true });
      setFlash(
        req,
        result.ok ? 'Outbound flow reachable (dryRun).' : `Outbound test failed: ${result.error}`,
        result.ok ? 'ok' : 'error',
      );
    } catch (err) {
      setFlash(req, `Outbound test failed: ${err.message}`, 'error');
    }
    return reply.redirect('/integrations');
  });
}

function injectCsrf(html, req) {
  return html.replaceAll('__CSRF__', req.session?.get('csrfToken') ?? '');
}
