import { handleValidation, extractIds, verifyClientState } from '../teams/webhook.js';
import { logger } from '../logging.js';

// Graph change-notification endpoint.
// GET with ?validationToken=... must echo the token back as plain text.
// POST receives notifications; each is processed by the ingestion pipeline.

export function registerWebhookRoutes(app, ctx) {
  const clientState = ctx.clientState;

  app.get('/webhook', async (req, reply) => {
    const result = handleValidation(req.query);
    if (result) {
      logger.info('webhook validation challenge answered');
      return reply.code(result.status).type('text/plain').send(result.body);
    }
    reply.code(200);
    return reply.send('ok');
  });

  app.post('/webhook', async (req, reply) => {
    try {
      const notifications = Array.isArray(req.body?.value) ? req.body.value : [];
      for (const notification of notifications) {
        // Never log tokens; log event id + change type only.
        logger.info(
          { eventId: notification.id, changeType: notification.changeType },
          'teams notification received',
        );
        await ctx.pipeline.processNotification(notification, { clientState });
      }
    } catch (err) {
      // Always return 2xx so Graph does not disable the subscription;
      // processing problems are logged, not thrown.
      logger.error({ err: err.message }, 'webhook processing error');
    }
    reply.code(202);
    return reply.send();
  });
}
