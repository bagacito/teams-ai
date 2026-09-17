import { z } from 'zod';

// ── Inbound payload (Power Automate → this app) ──────────────────────────────

export const inboundPayloadSchema = z.object({
  eventId: z.string().trim().min(1).max(200),
  messageId: z.string().trim().min(1).max(300),
  chatId: z.string().trim().min(1).max(300),
  chatName: z.string().trim().max(300).default(''),
  senderId: z.string().trim().min(1).max(300),
  senderName: z.string().trim().max(300).default(''),
  senderEmail: z.string().trim().max(300).default(''),
  messageText: z.string().max(10000).default(''),
  messageType: z.string().trim().max(50).default('message'),
  timestamp: z.string().trim().max(60).default(''),
  replyToMessageId: z.string().trim().max(300).nullish(),
  mentionedMe: z.boolean().default(false),
});

// ── Outbound payload (this app → Power Automate → Teams) ─────────────────────

export function buildOutboundPayload({ requestId, draftId, chatId, replyToMessageId, messageText, dryRun = false }) {
  return {
    requestId,
    draftId,
    chatId,
    replyToMessageId: replyToMessageId || null,
    messageText,
    ...(dryRun ? { dryRun: true } : {}),
  };
}

// ── Outbound response contract ───────────────────────────────────────────────

export const outboundResponseSchema = z.object({
  success: z.boolean(),
  teamsMessageId: z.string().trim().max(300).nullish(),
  error: z.string().trim().max(500).nullish(),
});

export function parseOutboundResponse(body) {
  const parsed = outboundResponseSchema.safeParse(body);
  if (!parsed.success) return { ok: false, error: 'invalid outbound response shape' };
  const { success, teamsMessageId, error } = parsed.data;
  if (!success) return { ok: false, error: error || 'Power Automate flow reported failure' };
  return { ok: true, teamsMessageId: teamsMessageId ?? null };
}
