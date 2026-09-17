import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import session from '@fastify/session';
import formbody from '@fastify/formbody';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { logger } from './logging.js';
import { createGuards, replyHtml } from './routes/guards.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerDraftRoutes } from './routes/drafts.js';
import { registerUserRoutes } from './routes/users.js';
import { registerChatRoutes } from './routes/chats.js';
import { registerStyleRoutes } from './routes/style.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerInboundEndpoint } from './integrations/power-automate/inbound.js';
import { registerIntegrationsRoutes } from './routes/integrations.js';

// Routes that bypass admin auth / CSRF (login handles its own CSRF).
const PUBLIC_PATHS = new Set(['/login', '/logout', '/health', '/api/power-automate/inbound']);

export function createApp(ctx) {
  const app = Fastify({
    loggerInstance: logger.child({ component: 'http' }),
    trustProxy: true,
  });

  const secureCookies = (process.env.PUBLIC_BASE_URL || '').startsWith('https://');

  app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        formAction: ["'self'"],
        frameAncestors: ["'self'"],
      },
    },
    hsts: secureCookies ? undefined : false,
  });
  app.register(cookie);
  app.register(session, {
    secret: ctx.sessionSecret,
    cookie: {
      // Secure flag is decided per request (see onPreHandler below) so the UI
      // works over plain HTTP on the LAN while staying Secure behind TLS.
      secure: false,
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
      path: '/',
    },
  });
  app.register(formbody);
  app.register(rateLimit, { global: false });

  app.addHook('preHandler', async (req) => {
    if (req.session) {
      // trustProxy is on: req.protocol honors X-Forwarded-Proto from the
      // reverse proxy, so Secure is set exactly when the browser used HTTPS.
      req.session.cookie.secure = req.protocol === 'https';
    }
  });

  const guards = createGuards(ctx);

  app.addHook('preValidation', async (req, reply) => {
    if (req.method !== 'POST') return;
    const path = req.routeOptions?.url ?? req.raw.url?.split('?')[0] ?? '';
    if (PUBLIC_PATHS.has(path) || path === '/login') return;
    await guards.verifyCsrf(req, reply);
  });

  app.addHook('preHandler', async (req, reply) => {
    const path = req.routeOptions?.url ?? req.raw.url?.split('?')[0] ?? '';
    if (PUBLIC_PATHS.has(path)) return;
    await guards.requireAuth(req, reply);
  });

  app.get('/health', async () => ({ status: 'ok' }));

  registerInboundEndpoint(app, ctx);
  registerAuthRoutes(app, ctx);
  registerDraftRoutes(app, ctx);
  registerUserRoutes(app, ctx);
  registerChatRoutes(app, ctx);
  registerStyleRoutes(app, ctx);
  registerSettingsRoutes(app, ctx);
  registerIntegrationsRoutes(app, ctx);

  app.setErrorHandler((err, req, reply) => {
    if (err.statusCode && err.statusCode < 500) {
      reply.code(err.statusCode);
      return reply.send(err.message);
    }
    ctx.logger.error({ err: err.message, url: req.raw.url }, 'unhandled request error');
    reply.code(500);
    return reply.send('Internal error');
  });

  return app;
}

export { replyHtml };
