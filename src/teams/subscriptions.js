import crypto from 'node:crypto';
import { graphFetch } from './graph.js';
import { logger } from '../logging.js';

// Graph change-notification subscriptions for /chats/{id}/messages.
// Handles creation, renewal before expiry, and recreation on renewal failure.

const RESOURCE_TEMPLATE = '/chats/{chat-id}/messages';
const DEFAULT_LIFETIME_MINUTES = 55; // Graph minimum for chatMessage subscriptions is ~60? keep 55 to be safe under 1h

export function notificationUrl() {
  const base = process.env.PUBLIC_BASE_URL;
  if (!base) throw new Error('PUBLIC_BASE_URL is required for subscriptions');
  return `${base.replace(/\/+$/, '')}/webhook`;
}

export async function createSubscription(chatId, { lifetimeMinutes } = {}) {
  const minutes = lifetimeMinutes || Number(process.env.GRAPH_SUBSCRIPTION_MINUTES) || DEFAULT_LIFETIME_MINUTES;
  const expirationDateTime = new Date(Date.now() + minutes * 60_000).toISOString();
  const sub = await graphFetch('/subscriptions', {
    method: 'POST',
    body: {
      changeType: 'created',
      notificationUrl: notificationUrl(),
      resource: RESOURCE_TEMPLATE.replace('{chat-id}', chatId),
      expirationDateTime,
      // Delegated auth: clientState still recommended for validation.
      clientState: crypto.randomBytes(16).toString('hex'),
    },
  });
  logger.info(
    { subscriptionId: sub.id, chatId, expiresAt: sub.expirationDateTime },
    'subscription created',
  );
  return sub;
}

export async function renewSubscription(subscriptionId, { lifetimeMinutes } = {}) {
  const minutes = lifetimeMinutes || Number(process.env.GRAPH_SUBSCRIPTION_MINUTES) || DEFAULT_LIFETIME_MINUTES;
  const expirationDateTime = new Date(Date.now() + minutes * 60_000).toISOString();
  const sub = await graphFetch(`/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    method: 'PATCH',
    body: { expirationDateTime },
  });
  logger.info({ subscriptionId, expiresAt: sub.expirationDateTime }, 'subscription renewed');
  return sub;
}

export async function deleteSubscription(subscriptionId) {
  await graphFetch(`/subscriptions/${encodeURIComponent(subscriptionId)}`, { method: 'DELETE' });
  logger.info({ subscriptionId }, 'subscription deleted');
}

// Renew all subscriptions that expire within `renewWithinMs`, recreate failures.
export async function renewDueSubscriptions({ subRepo, renewWithinMs = 10 * 60_000, lifetimeMinutes } = {}) {
  const now = Date.now();
  const results = [];
  for (const sub of subRepo.list()) {
    const expiresAt = Date.parse(sub.expires_at);
    if (Number.isNaN(expiresAt)) continue;
    const due = expiresAt - now <= renewWithinMs;
    if (!due || sub.status === 'expired') continue;

    try {
      const renewed = await renewSubscription(sub.subscription_id, { lifetimeMinutes });
      subRepo.markRenewed(sub.id, renewed.expirationDateTime);
      results.push({ chatId: sub.teams_chat_id, ok: true, action: 'renewed' });
    } catch (err) {
      logger.warn(
        { chatId: sub.teams_chat_id, subscriptionId: sub.subscription_id, errStatus: err.status },
        'subscription renewal failed, attempting recreate',
      );
      subRepo.markError(sub.id, 'error', err.message);
      try {
        await deleteSubscription(sub.subscription_id).catch(() => {});
        const fresh = await createSubscription(sub.teams_chat_id, { lifetimeMinutes });
        const saved = subRepo.save({
          teamsChatId: sub.teams_chat_id,
          subscriptionId: fresh.id,
          resource: fresh.resource,
          status: 'active',
          expiresAt: fresh.expirationDateTime,
        });
        results.push({ chatId: sub.teams_chat_id, ok: true, action: 'recreated', id: saved?.id });
      } catch (err2) {
        subRepo.markError(sub.id, 'error', err2.message);
        logger.error({ chatId: sub.teams_chat_id, errStatus: err2.status }, 'subscription recreate failed');
        results.push({ chatId: sub.teams_chat_id, ok: false, action: 'failed' });
      }
    }
  }
  return results;
}

// Auto-subscribe to every enabled allowed chat that has no active subscription.
export async function ensureSubscriptions({ chatRepo, subRepo, lifetimeMinutes } = {}) {
  const results = [];
  for (const chat of chatRepo.list()) {
    if (!chat.enabled) continue;
    const existing = subRepo.getByChatId(chat.teams_chat_id);
    if (existing && existing.status === 'active' && Date.parse(existing.expires_at) > Date.now()) {
      continue;
    }
    try {
      const sub = await createSubscription(chat.teams_chat_id, { lifetimeMinutes });
      subRepo.save({
        teamsChatId: chat.teams_chat_id,
        subscriptionId: sub.id,
        resource: sub.resource,
        status: 'active',
        expiresAt: sub.expirationDateTime,
      });
      results.push({ chatId: chat.teams_chat_id, ok: true, action: existing ? 'recreated' : 'created' });
    } catch (err) {
      logger.error({ chatId: chat.teams_chat_id, errStatus: err.status }, 'ensure subscription failed');
      results.push({ chatId: chat.teams_chat_id, ok: false, action: 'failed' });
    }
  }
  return results;
}
