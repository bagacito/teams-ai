import { inboundPayloadSchema } from './schemas.js';
import { verifyInboundAuth } from './signature.js';
import { recordFromPayload, createIngestionPipeline } from '../../pipeline/ingest.js';
import { logger } from '../../logging.js';

// Authenticated HTTP endpoint receiving message events from Power Automate.
//
// Response codes:
//   200 — accepted OR intentionally ignored (duplicates, non-eligible, etc.)
//   400 — malformed payload
//   401 — missing/invalid shared secret
//   500 — unexpected failure only
//
// Rate limiting is applied generously so legitimate Power Automate retries
// succeed; secrets and authorization headers are never logged.

export function registerInboundEndpoint(app, ctx) {
  app.post(
    '/api/power-automate/inbound',
    { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } },
    async (req, reply) => {
      try {
        const secret = ctx.inboundSecret;
        if (!verifyInboundAuth(req, secret)) {
          logger.warn({ ip: req.ip }, 'inbound request rejected: invalid secret');
          reply.code(401);
          return reply.send({ error: 'unauthorized' });
        }

        const parsed = inboundPayloadSchema.safeParse(req.body ?? {});
        if (!parsed.success) {
          logger.warn({ ip: req.ip, issues: parsed.error.issues.length }, 'inbound request rejected: malformed payload');
          reply.code(400);
          return reply.send({ error: 'malformed payload', issues: parsed.error.issues.map((i) => i.path.join('.')) });
        }

        const payload = parsed.data;
        logger.info(
          { eventId: payload.eventId, messageId: payload.messageId, chatId: payload.chatId },
          'power automate inbound request received',
        );

        const record = recordFromPayload(payload, {
          myUserId: ctx.myUserId,
          myEmail: ctx.myEmail,
        });

        const result = await ctx.pipeline.processMessage(record, { eventId: payload.eventId });

        // Intentionally-ignored messages are still 200 for Power Automate.
        reply.code(200);
        return reply.send({ accepted: true, processed: result.processed, reason: result.reason ?? null });
      } catch (err) {
        logger.error({ err: err.message }, 'inbound unexpected failure');
        reply.code(500);
        return reply.send({ error: 'internal error' });
      }
    },
  );
}
