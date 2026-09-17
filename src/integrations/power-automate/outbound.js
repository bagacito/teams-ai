// ─────────────────────────────────────────────────────────────────────────────
// Outbound Power Automate sender.
//
// SECURITY BOUNDARY: this module may only be invoked from the approval flow
// (src/routes/drafts.js). The AI draft-generation pipeline (src/ai/*,
// src/pipeline/*) MUST NOT import or call this module.
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'node:crypto';
import { buildOutboundPayload, parseOutboundResponse } from './schemas.js';
import { logger } from '../../logging.js';

const DEFAULT_TIMEOUT_MS = 15_000;

export function isOutboundConfigured() {
  return !!(process.env.POWER_AUTOMATE_OUTBOUND_URL && process.env.POWER_AUTOMATE_OUTBOUND_SECRET);
}

export function createOutboundSender({
  url = process.env.POWER_AUTOMATE_OUTBOUND_URL,
  secret = process.env.POWER_AUTOMATE_OUTBOUND_SECRET,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
} = {}) {
  // Configuration is checked lazily so the app can boot before the flow is set up.

  // Returns { ok, httpStatus, teamsMessageId, error, requestId }.
  // Never logs the secret or the Authorization header.
  async function sendReply({ requestId: providedRequestId, draftId, chatId, replyToMessageId = null, messageText, dryRun = false }) {
    if (!url || !secret) {
      return { ok: false, httpStatus: null, teamsMessageId: null, requestId: providedRequestId ?? null, error: 'outbound not configured (POWER_AUTOMATE_OUTBOUND_URL / POWER_AUTOMATE_OUTBOUND_SECRET)' };
    }
    // requestId is normally supplied by the approval flow (stored on the draft
    // atomically at claim time) so callers and the flow can dedupe retries.
    const requestId = providedRequestId || crypto.randomUUID();
    const payload = buildOutboundPayload({ requestId, draftId, chatId, replyToMessageId, messageText, dryRun });

    logger.info({ requestId, draftId, chatId, dryRun }, 'outbound send started');
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res;
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${secret}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      const httpStatus = res.status;
      let body = null;
      try {
        body = await res.json();
      } catch {
        body = null; // non-JSON response body
      }

      // HTTP 2xx + validated body = success. A 2xx with an unparseable body is
      // treated as success only if status is 2xx and body absent (Power
      // Automate sometimes returns empty 202 while the flow continues) — but we
      // prefer an explicit contract: 2xx requires success:true when JSON is present.
      if (res.ok) {
        if (body === null) {
          // Ambiguous: the flow accepted the request but returned no contract.
          // Treat as success (the send may still complete asynchronously in the
          // flow); requestId allows the flow to dedupe any caller-side retry.
          logger.info({ requestId, httpStatus }, 'outbound accepted without JSON body');
          return { ok: true, httpStatus, teamsMessageId: null, error: null, requestId };
        }
        const parsed = parseOutboundResponse(body);
        if (parsed.ok) {
          logger.info(
            { requestId, httpStatus, teamsMessageId: parsed.teamsMessageId },
            'outbound send succeeded',
          );
          return { ok: true, httpStatus, teamsMessageId: parsed.teamsMessageId, error: null, requestId };
        }
        logger.warn({ requestId, httpStatus }, 'outbound 2xx but contract mismatch');
        return { ok: false, httpStatus, teamsMessageId: null, error: parsed.error, requestId };
      }

      const safeError = body?.error || `Power Automate flow returned HTTP ${httpStatus}`;
      logger.warn({ requestId, httpStatus }, 'outbound send failed');
      return { ok: false, httpStatus, teamsMessageId: null, error: String(safeError).slice(0, 300), requestId };
    } catch (err) {
      // Timeout/abort is intentionally NOT retried here: retrying could post
      // duplicate Teams messages when the first attempt actually went through.
      // The draft is marked failed and a human can use Retry; requestId lets
      // the flow dedupe if it supports it.
      const msg = err.name === 'AbortError' ? `outbound timeout after ${timeoutMs}ms` : err.message;
      logger.warn({ requestId, draftId, errName: err?.name }, 'outbound send failed');
      return { ok: false, httpStatus: null, teamsMessageId: null, error: msg, requestId };
    }
  }

  // Non-destructive connectivity test: dryRun=true must not post to Teams.
  async function testConnection() {
    return sendReply({
      draftId: null,
      chatId: 'test',
      messageText: '',
      dryRun: true,
    });
  }

  return { sendReply, testConnection };
}
