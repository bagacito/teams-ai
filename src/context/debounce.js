// Per-chat draft debounce. When someone splits a point across several
// messages, the first message must not trigger a draft for a fragment.
// The debouncer holds response-worthy messages per chat and fires ONE flush
// per chat after `delayMs` of quiet — the flush regenerates the context from
// the database, so every message stored in the meantime is included.
//
// In-memory only: after a restart the poller's retry path re-schedules flushes
// for messages that still have no draft, so state recovery is automatic.
// Timers are unref'd so they never keep the process alive.

export function createDraftDebouncer({ delayMs, flush, log = console }) {
  if (!delayMs || delayMs <= 0) throw new Error('debounce delayMs must be > 0');
  // chatId -> { timer, record, count }
  const pending = new Map();

  function schedule(chatId, record) {
    const existing = pending.get(chatId);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      pending.delete(chatId);
      Promise.resolve()
        .then(() => flush(chatId, record))
        .catch((err) => log.warn?.({ err: err.message, chatId }, 'debounced draft flush failed'));
    }, delayMs);
    timer.unref?.();
    pending.set(chatId, { timer, record, count: (existing?.count ?? 0) + 1 });
  }

  function cancel(chatId) {
    const existing = pending.get(chatId);
    if (existing) clearTimeout(existing.timer);
    pending.delete(chatId);
  }

  return {
    schedule,
    cancel,
    isPending: (chatId) => pending.has(chatId),
    pendingCount: (chatId) => pending.get(chatId)?.count ?? 0,
    pendingChats: () => [...pending.keys()],
  };
}
