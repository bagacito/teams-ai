import crypto from 'node:crypto';
import { esc, layout } from '../views/layout.js';

// Session/auth + CSRF helpers shared by route modules.

export function createGuards(ctx) {
  return {
    // Require an authenticated admin session; redirect to /login otherwise.
    requireAuth: async (req, reply) => {
      if (!req.session?.get('authenticated')) {
        reply.redirect('/login');
        return reply;
      }
      // Ensure a CSRF token exists for this session.
      if (!req.session.get('csrfToken')) {
        req.session.set('csrfToken', crypto.randomBytes(24).toString('hex'));
      }
    },

    // Verify CSRF token on state-changing requests.
    verifyCsrf: async (req, reply) => {
      const expected = req.session?.get('csrfToken');
      const provided = req.body?._csrf;
      if (!expected || !provided || !safeEqual(expected, provided)) {
        reply.code(403);
        return reply.send('CSRF token invalid');
      }
      // Rotate the token after use.
      req.session.set('csrfToken', crypto.randomBytes(24).toString('hex'));
    },
  };
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export function renderPage({ req, title, active, body }) {
  const flash = req.session?.get('flash');
  if (flash) req.session.set('flash', null);
  return layout({
    title,
    active,
    csrf: req.session?.get('csrfToken') ?? '',
    flash,
    body,
  });
}

export function replyHtml(req, reply, { title, active, body, status }) {
  const html = renderPage({ req, title, active, body });
  if (status) reply.code(status);
  return reply.type('text/html').send(html);
}

export function setFlash(req, message, type = 'ok') {
  req.session.set('flash', { message, type });
}
