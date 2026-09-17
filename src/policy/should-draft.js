// Decides whether an incoming message warrants a suggested reply.
// Rule-based for the initial version; kept isolated so it can later be
// replaced or complemented by AI classification.

const IGNORE_PATTERNS = [
  /^\s*ok(a)?y?\s*[.!.]*\s*$/i,
  /^\s*k\s*[.!.]*\s*$/,
  /^\s*(thanks?|thank you|thx|ty|tks)\s*(you)?\s*(so much|a lot|very much)?\s*[.!,]*\s*$/i,
  /^\s*(you'?re welcome|np|no problem|de nada)\s*[.!,]*\s*$/i,
  /^\s*(hi|hello|hey|ol[áa]|oi|bom dia|boa tarde|boa noite)\s*[.!,]*\s*$/i,
  /^\s*(good (morning|afternoon|evening|night))\s*[.!,]*\s*$/i,
  /^\s*by(e|e e)?\s*[.!,]*\s*$/i,
  /^\s*(yes|no|yeah|yep|nope|sure|done|done!|feito)\s*[.!,]*\s*$/i,
];

const REQUEST_PATTERNS = [
  /\b(could you|can you|would you|please|por favor|podes?|consegues?|preciso|necessito)\b/i,
  /\b(what do you think|your opinion|thoughts\??|quanto|when|quando|where|onde|how|como)\b/i,
];

const QUESTION_PATTERNS = [
  /\?\s*$/,
  /\?\s*[^\s?]/, // question mark mid-message (multi-question)
];

function isEmojiOnly(text) {
  const stripped = text
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Component}]/gu, '')
    .replace(/\s/g, '');
  return text.trim().length > 0 && stripped.length === 0;
}

function isGifOrImageOnly(text) {
  const t = text.trim();
  if (/^<gif\b/i.test(t)) return true;
  if (/^<image/i.test(t)) return true;
  if (/(^|\s)https?:\/\/\S*(gif|giphy|tenor)\S*/i.test(t) && t.split(/\s+/).length <= 2) return true;
  return false;
}

export function shouldDraft(message) {
  const reason = firstIgnoreReason(message);
  if (reason) return { draft: false, reason };
  return { draft: true, reason: 'looks-response-worthy' };
}

export function firstIgnoreReason(message) {
  const type = (message.messageType || 'message').toLowerCase();
  if (type !== 'message') return `unsupported-message-type:${type}`;
  if (message.isMe) return 'own-message';

  const text = String(message.content || '').trim();
  if (!text) return 'empty-content';
  if (isEmojiOnly(text)) return 'emoji-only';
  if (isGifOrImageOnly(text)) return 'gif-or-image-only';
  if (IGNORE_PATTERNS.some((p) => p.test(text))) return 'non-response-content';

  const wantsResponse =
    QUESTION_PATTERNS.some((p) => p.test(text)) ||
    REQUEST_PATTERNS.some((p) => p.test(text)) ||
    (message.mentionsMe === true);

  if (!wantsResponse) return 'no-response-signal';
  return null;
}
