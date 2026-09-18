import { isUsableStyleCandidate } from '../pipeline/ingest.js';

// Bulk style extraction: pulls recent messages from every enabled chat via the
// Teams provider and turns messages the user actually sent into style
// examples. Deduplication (identical text) and usability filtering are shared
// with the live capture path, so sync and polling produce the same result.
//
// Read-only towards Teams (getMessages only); it never sends anything.

export async function syncStyleFromChats(ctx, { limit = 200 } = {}) {
  const chats = ctx.repos.chatRepo.list().filter((c) => c.enabled);
  const result = {
    chatsTotal: chats.length,
    chatsFetched: 0,
    chatsFailed: 0,
    authRequired: false,
    added: 0,
    duplicates: 0,
    candidates: 0,
  };

  for (const chat of chats) {
    const res = await ctx.teamsProvider.getMessages(chat.teams_chat_id, { limit });
    if (!res.ok) {
      if (res.errorType === 'AUTH_REQUIRED') result.authRequired = true;
      result.chatsFailed++;
      continue;
    }
    result.chatsFetched++;
    for (const m of res.messages) {
      if (!m.isFromMe) continue;
      if (!isUsableStyleCandidate(m.content)) continue;
      result.candidates++;
      if (ctx.repos.styleRepo.add(m.content, 'teams', chat.teams_chat_id)) result.added++;
      else result.duplicates++;
    }
  }
  return result;
}
