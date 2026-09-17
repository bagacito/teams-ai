import { sendNtfy, formatNotification } from './ntfy.js';
import { logger } from '../logging.js';

// Provider abstraction. ntfy implemented first; add other providers here.
const providers = { ntfy: sendNtfy };

export function createNotifier(config = {}) {
  const providerName = config.provider || 'ntfy';
  const send = providers[providerName];
  if (!send) throw new Error(`unknown notification provider: ${providerName}`);

  return {
    async notifyNewDraft(draft, { chatName } = {}) {
      const detailMode = config.detailMode || process.env.NTFY_DETAIL_MODE || 'minimal';
      const baseUrl = (config.publicBaseUrl || process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
      const url = baseUrl ? `${baseUrl}/drafts` : '/drafts';

      const payload = formatNotification(draft, {
        chatName,
        detailMode,
        url,
        topic: config.topic || process.env.NTFY_TOPIC,
        server: config.url || process.env.NTFY_URL,
        token: config.token || process.env.NTFY_TOKEN,
      });
      if (!payload) {
        logger.warn('ntfy not configured, notification skipped');
        return false;
      }
      try {
        await send(payload);
        logger.info({ draftId: draft.id, mode: detailMode }, 'draft notification sent');
        return true;
      } catch (err) {
        logger.warn({ err: err.message }, 'notification send failed');
        return false;
      }
    },
  };
}
