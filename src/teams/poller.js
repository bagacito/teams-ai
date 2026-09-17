// ─────────────────────────────────────────────────────────────────────────────
// Teams poller.
//
// SAFETY: the poller only READS from Teams and feeds messages into the
// ingestion pipeline (pending drafts + notification). It never sends anything
// and never receives a provider send capability beyond the provider object —
// but the pipeline itself has no send path at all (see pipeline/ingest.js).
//
// Poll algorithm (single-flight: overlapping runs are skipped):
//  1. provider.listChats()
//  2. keep chats relevant to the allowlist (allowed chat, allowed user in a
//     1:1 chat id, or an existing poll cursor)
//  3. per chat: skip when unchanged (last message id/timestamp matches cursor)
//  4. fetch messages newer than the saved cursor
//  5. sort oldest→newest, dedupe by Teams message id
//  6. run each through the ingestion pipeline (stores, allows, shouldDraft,
//     generates pending draft, notifies)
//  7. advance the cursor only after the chat processed without error
//  8. one chat failing must not stop the others
//
// Repeated provider failures trigger exponential backoff (skipped cycles).
// ─────────────────────────────────────────────────────────────────────────────

const MAX_BACKOFF_MS = 10 * 60_000;

export function createPoller({ ctx, provider }) {
  const { logger, repos, pipeline, settingsRepo } = ctx;
  const log = logger.child({ component: 'poller' });

  const intervalSeconds = Math.max(Number(process.env.TEAMS_POLL_INTERVAL_SECONDS) || 60, 5);
  const minInterval = Math.max(Number(process.env.TEAMS_POLL_MIN_INTERVAL_SECONDS) || 15, 5);
  const intervalMs = Math.max(intervalSeconds, minInterval) * 1000;

  const state = {
    running: false, // polling enabled by admin?
    active: false, // a poll is executing right now
    timer: null,
    consecutiveFailures: 0,
    lastPollAt: null,
    lastSuccessAt: null,
    lastError: null,
    lastStats: { chatsScanned: 0, messagesDiscovered: 0 },
  };

  function isRelevant(chat, { allowedUserIds, hasCursor }) {
    if (hasCursor) return true;
    const row = repos.chatRepo.getByChatId(chat.id);
    if (row && row.enabled) return true;
    const ids = (allowedUserIds.length && allowedUserIds.map((u) => String(u).toLowerCase())) || [];
    if (!ids.length) return false;
    // 1:1 chat ids embed both participant ids: 19:<guid>_<guid>@unq.gbl.spaces
    if (ids.some((uid) => chat.id.toLowerCase().includes(uid))) return true;
    // Group chats expose participants via discovery; match on those too.
    if (Array.isArray(chat.participants) && chat.participants.some((p) => ids.includes(String(p).toLowerCase()))) return true;
    return false;
  }

  function allowedUserIds() {
    // My own id is excluded: I participate in every chat I can see, so
    // including it would make every chat "relevant" and defeat the skip logic.
    return repos.userRepo
      .list()
      .filter((u) => u.enabled)
      .map((u) => u.entra_user_id);
  }

  async function pollOnce({ trigger = 'interval' } = {}) {
    if (state.active) {
      log.info({ trigger }, 'poll skipped: previous poll still running');
      return { skipped: true, reason: 'overlap' };
    }
    state.active = true;
    state.lastPollAt = new Date().toISOString();
    const stats = { chatsScanned: 0, messagesDiscovered: 0, drafts: 0, errors: 0 };
    try {
      // 0. Authentication gate: without a session we must not hammer the CLI.
      const st = await provider.status();
      if (!st.ok || st.loginRequired || !st.authenticated) {
        state.lastError = st.error || 'Teams authentication required';
        state.consecutiveFailures += 1;
        log.warn({ error: state.lastError }, 'poll aborted: Teams not authenticated');
        return { ok: false, reason: 'auth-required', error: state.lastError };
      }

      // 1-2. Discover chats and reduce to relevant ones.
      const chatsRes = await provider.listChats({ limit: 200 });
      if (!chatsRes.ok) {
        throw new Error(chatsRes.error || 'listChats failed');
      }
      const userIds = allowedUserIds();
      const relevant = chatsRes.chats.filter((c) =>
        isRelevant(c, { allowedUserIds: userIds, hasCursor: !!repos.pollStateRepo.cursor(c.id) }),
      );
      stats.chatsScanned = relevant.length;

      // 3-7. Per-chat processing; errors isolated per chat.
      for (const chat of relevant) {
        try {
          const cursor = repos.pollStateRepo.cursor(chat.id);
          const skip = isUnchanged(chat, cursor);
          if (skip) {
            repos.pollStateRepo.record(chat.id, { ok: true });
            continue;
          }

          const since = cursor?.lastMessageTimestamp || null;
          const res = await provider.getMessages(chat.id, { since, limit: 50 });
          if (!res.ok) throw new Error(res.error || 'getMessages failed');

          // Dedupe + oldest→newest ordering.
          const seen = new Set();
          const fresh = [];
          for (const m of res.messages) {
            if (seen.has(m.id)) continue;
            seen.add(m.id);
            if (cursor && isNewerThanCursor(m, cursor)) fresh.push(m);
            else if (!cursor) fresh.push(m);
          }
          fresh.sort((a, b) => compareMessages(a, b));
          stats.messagesDiscovered += fresh.length;

          let lastMsg = null;
          let lastErr = null;
          for (const m of fresh) {
            // Pipeline stores the message, applies allowlist + shouldDraft,
            // generates a pending draft and notifies. It never sends.
            try {
              const res = await pipeline.processMessage(toRecord(m), { eventId: null, retry: true });
              // Transient AI/generation failures must not advance the cursor.
              if (!res.processed && res.reason === 'generation-failed') {
                throw new Error('draft generation failed');
              }
              lastMsg = m;
            } catch (err) {
              lastErr = err;
              log.warn({ err: err.message, chatId: chat.id, messageId: m.id }, 'message processing failed');
              break; // keep cursor behind the failure point
            }
          }

          if (lastErr) {
            stats.errors += 1;
            repos.pollStateRepo.record(chat.id, { ok: false, error: lastErr.message });
          } else {
            // Advance the cursor to the newest processed/seen message.
            const newest = lastMsg ?? (fresh.length ? fresh[fresh.length - 1] : null);
            const meta = newest ?? chatMeta(chat);
            repos.pollStateRepo.record(chat.id, {
              ok: true,
              lastMessageId: newest?.id ?? meta.id,
              lastMessageTimestamp: newest?.createdAt ?? meta.timestamp,
            });
          }
        } catch (err) {
          stats.errors += 1;
          repos.pollStateRepo.record(chat.id, { ok: false, error: err.message });
          log.warn({ err: err.message, chatId: chat.id }, 'chat poll failed');
        }
      }

      state.lastSuccessAt = new Date().toISOString();
      state.lastError = stats.errors > 0 ? `${stats.errors} chat(s) failed` : null;
      state.lastStats = { chatsScanned: stats.chatsScanned, messagesDiscovered: stats.messagesDiscovered };
      state.consecutiveFailures = stats.errors === relevant.length && relevant.length > 0 ? state.consecutiveFailures + 1 : 0;
      return { ok: true, stats };
    } catch (err) {
      state.lastError = err.message;
      state.consecutiveFailures += 1;
      log.warn({ err: err.message }, 'poll cycle failed');
      return { ok: false, error: err.message };
    } finally {
      state.active = false;
    }
  }

  // Unchanged chat = cursor id equals provider-visible last message id
  // (falls back to timestamp comparison when ids differ in shape).
  function isUnchanged(chat, cursor) {
    if (!cursor) return false;
    const last = chatMeta(chat);
    if (!last.id && !last.timestamp) return false;
    if (last.id && cursor.lastMessageId && last.id === cursor.lastMessageId) return true;
    if (!last.id && last.timestamp && cursor.lastMessageTimestamp && last.timestamp <= cursor.lastMessageTimestamp) return true;
    return false;
  }

  function chatMeta(chat) {
    const lm = chat.lastMessage ?? {};
    return { id: lm.id ?? lm.messageId ?? null, timestamp: lm.timestamp ?? '' };
  }

  function isNewerThanCursor(m, cursor) {
    if (cursor.lastMessageId && m.id === cursor.lastMessageId) return false;
    if (cursor.lastMessageTimestamp && m.createdAt) {
      return m.createdAt > cursor.lastMessageTimestamp;
    }
    return true;
  }

  function compareMessages(a, b) {
    const ta = Date.parse(a.createdAt || '') || 0;
    const tb = Date.parse(b.createdAt || '') || 0;
    if (ta !== tb) return ta - tb;
    return Number(a.id) - Number(b.id) || String(a.id).localeCompare(String(b.id));
  }

  // Provider message -> normalized pipeline record.
  function toRecord(m) {
    const isMe =
      m.isFromMe === true ||
      (ctx.myUserId && m.senderId && m.senderId === ctx.myUserId) ||
      (ctx.myEmail && m.senderEmail && m.senderEmail.toLowerCase() === ctx.myEmail.toLowerCase());
    return {
      teamsMessageId: m.id,
      chatId: m.chatId,
      senderId: m.senderId,
      senderName: m.senderName,
      content: m.content,
      messageType: 'message',
      replyTo: m.replyToMessageId,
      isMe,
      mentionsMe: false,
      chatName: '',
      timestamp: m.createdAt,
    };
  }

  function schedule() {
    if (state.timer) clearTimeout(state.timer);
    if (!state.running) return;
    // Exponential backoff on consecutive failures.
    const backoff = state.consecutiveFailures > 0
      ? Math.min(intervalMs * 2 ** Math.min(state.consecutiveFailures, 6), MAX_BACKOFF_MS)
      : intervalMs;
    state.timer = setTimeout(async () => {
      await pollOnce();
      schedule();
    }, backoff);
    state.timer.unref?.();
  }

  return {
    // Startup: start only when a session already exists; otherwise stay
    // paused and report auth-required (the app must not crash).
    async start() {
      if (state.running) return;
      const paused = settingsRepo.get('polling_paused', 'false') === 'true';
      const st = await provider.status().catch(() => ({ ok: false, authenticated: false, loginRequired: false }));
      if (!st.authenticated) {
        state.lastError = st.error || 'Teams authentication required';
        log.warn('Teams not authenticated; poller waiting (admin UI available)');
      }
      state.running = !paused;
      if (state.running) schedule();
    },
    stop() {
      state.running = false;
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
    },
    pause() {
      state.running = false;
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
      settingsRepo.set('polling_paused', 'true');
    },
    resume() {
      settingsRepo.set('polling_paused', 'false');
      if (state.running) return;
      state.running = true;
      schedule();
    },
    // Manual trigger; never overlaps an active poll (pollOnce guards).
    async pollNow() {
      return pollOnce({ trigger: 'manual' });
    },
    intervalMs() {
      return intervalMs;
    },
    status() {
      return {
        running: state.running,
        active: state.active,
        intervalSeconds,
        lastPollAt: state.lastPollAt,
        lastSuccessAt: state.lastSuccessAt,
        lastError: state.lastError,
        consecutiveFailures: state.consecutiveFailures,
        lastStats: { ...state.lastStats },
      };
    },
  };
}
