import crypto from 'node:crypto';
import { esc, layout } from '../views/layout.js';

export function registerAuthRoutes(app, ctx) {
  app.get('/login', async (req, reply) => {
    if (req.session.get('authenticated')) return reply.redirect('/drafts');
    if (!req.session.get('csrfToken')) {
      req.session.set('csrfToken', crypto.randomBytes(24).toString('hex'));
    }
    return reply.type('text/html').send(loginPage(null, req.session.get('csrfToken')));
  });

  app.post(
    '/login',
    {
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      preValidation: async (req) => {
        if (!req.session.get('csrfToken')) {
          req.session.set('csrfToken', crypto.randomUUID());
        }
      },
    },
    async (req, reply) => {
      const expected = req.session.get('csrfToken');
      if (!expected || req.body?._csrf !== expected) {
        reply.code(403);
        return reply.send('CSRF token invalid');
      }
      const password = String(req.body?.password ?? '');
      if (!ctx.repos.adminAuthRepo.verifyPassword(password)) {
        ctx.logger.warn({ ip: req.ip }, 'failed admin login');
        req.session.set('csrfToken', crypto.randomBytes(24).toString('hex'));
        return reply.code(401).type('text/html').send(loginPage('Wrong password.', req.session.get('csrfToken')));
      }
      req.session.set('authenticated', true);
      req.session.set('csrfToken', crypto.randomBytes(24).toString('hex'));
      ctx.logger.info({ ip: req.ip }, 'admin login');
      return reply.redirect('/drafts');
    },
  );

  app.post('/logout', async (req, reply) => {
    req.session.delete();
    return reply.redirect('/login');
  });
}

function loginPage(error, csrf) {
  const body = `
  <div class="card login">
    <h1>Sign in</h1>
    <p class="muted">Administration and draft approval.</p>
    ${error ? `<div class="flash bad">${esc(error)}</div>` : ''}
    <form method="post" action="/login">
      <input type="hidden" name="_csrf" value="${esc(csrf)}">
      <label for="password">Admin password</label>
      <input type="password" id="password" name="password" autofocus autocomplete="current-password">
      <div class="actions"><button class="btn primary" type="submit">Sign in</button></div>
    </form>
  </div>`;
  return layout({ title: 'Sign in', active: '', csrf, flash: null, body });
}
