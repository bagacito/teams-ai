// ─────────────────────────────────────────────────────────────────────────────
// Message normalization for Teams MCP payloads.
//
// Teams message bodies are often HTML (RichText/Html). We convert them to
// readable plain text before storing / prompting the AI / showing in the UI.
// No raw provider session/auth data is ever kept; storage of raw payloads is
// disabled by default (STORAGE_CAPTURE_RAW env is not implemented on purpose
// until needed).
// ─────────────────────────────────────────────────────────────────────────────

const ENTITIES = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'",
  '&apos;': "'",
};

function decodeEntities(text) {
  let out = text;
  for (const [ent, ch] of Object.entries(ENTITIES)) {
    out = out.replaceAll(ent, ch);
  }
  // Numeric entities.
  out = out.replace(/&#(\d+);/g, (_, n) => {
    const code = Number(n);
    return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
  });
  out = out.replace(/&#x([0-9a-f]+);/gi, (_, n) => {
    const code = parseInt(n, 16);
    return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
  });
  return out;
}

// Converts a Teams message body (HTML or plain text) into clean readable text.
// - strips script/style/metadata entirely
// - preserves links as "text (url)" or bare url
// - keeps line structure from block elements
export function cleanContent(raw) {
  let text = String(raw ?? '');
  if (!text.trim()) return '';

  const looksHtml = /<[a-z!/][^>]*>/i.test(text);
  if (!looksHtml) {
    return decodeEntities(text)
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // Remove non-content blocks wholesale.
  text = text.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '');

  // Links: <a href="u">t</a> -> "t (u)" (skip when the visible text IS the url).
  text = text.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => {
    const t = decodeEntities(label).replace(/<[^>]*>/g, '').trim();
    const u = decodeEntities(href).trim();
    if (!u || u.startsWith('javascript:') || u.startsWith('data:')) return t;
    return t && t !== u ? `${t} (${u})` : u;
  });

  // Mention spans keep their visible text (e.g. @Name), drop metadata attrs.
  text = text.replace(/<img\b[^>]*alt=["']([^"']*)["'][^>]*>/gi, (_m, alt) => alt || '');
  text = text.replace(/<br\b[^>]*>/gi, '\n');
  text = text.replace(/<\/(p|div|tr|li|h[1-6]|blockquote|ul|ol)>/gi, '\n');
  text = text.replace(/<li\b[^>]*>/gi, '• ');

  // Strip every remaining tag, then decode entities.
  text = text.replace(/<[^>]*>/g, '');
  text = decodeEntities(text);

  return text
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Extracts an MRI from a sender value that may be a URL, MRI string or object.
function senderFrom(value, senderObj) {
  let id = null;
  let name = null;
  let email = null;

  if (senderObj && typeof senderObj === 'object') {
    id = senderObj.mri || senderObj.id || null;
    name = senderObj.displayName || senderObj.name || senderObj.Name || null;
    email = senderObj.email || senderObj.mail || null;
  }
  if (!id && typeof value === 'string') {
    // "https://teams.microsoft.com/api/chatsvc/.../contacts/8:orgid:guid" -> "8:orgid:guid"
    id = value.includes('/') ? value.split('/').pop() : value;
  }
  return { id, name, email };
}

// Normalizes one message object from the provider into the internal shape.
export function normalizeMessage(msg, chatId) {
  if (!msg || typeof msg !== 'object') return null;
  const id = String(msg.id ?? msg.messageId ?? '').trim();
  if (!id) return null;

  const sender = senderFrom(msg.from ?? msg.senderId ?? null, msg.sender);
  const displayName = sender.name || msg.imdisplayname || msg.senderName || null;

  const senderIdRaw = sender.id || msg.fromUserId || '';
  // MRIs look like "8:orgid:<guid>"; keep the whole MRI — it is what Teams
  // needs to mention/resolve, and settings my_user_id may be either form.
  const senderId = String(senderIdRaw).trim();

  return {
    id,
    chatId,
    senderId,
    senderName: displayName || '',
    senderEmail: sender.email || msg.senderEmail || '',
    content: cleanContent(msg.content ?? msg.body ?? ''),
    createdAt: msg.timestamp || msg.originalarrivaltime || msg.composetime || '',
    replyToMessageId: msg.threadRootId ?? msg.replyToMessageId ?? null,
    isFromMe: msg.isFromMe === true,
    rawType: msg.messagetype || msg.type || 'message',
  };
}

// Normalizes a conversation entry from teams_list_chats.
export function normalizeConversation(c) {
  if (!c || typeof c !== 'object') return null;
  const id = String(c.conversationId ?? c.id ?? '').trim();
  if (!id) return null;
  // teams_list_chats carries last-message info as top-level
  // lastMessageFrom/lastMessagePreview/lastMessageTime fields; other sources
  // use a nested lastMessage object. Support both shapes.
  let last = c.lastMessage && typeof c.lastMessage === 'object' ? c.lastMessage : null;
  if (!last && (c.lastMessageFrom || c.lastMessagePreview || c.lastMessageTime)) {
    last = {
      senderName: c.lastMessageFrom || '',
      preview: c.lastMessagePreview || '',
      time: c.lastMessageTime || '',
    };
  }
  return {
    id,
    title: c.topic || c.displayName || c.title || '(unnamed)',
    type: c.chatType || c.type || 'chat',
    participants: Array.isArray(c.members)
      ? c.members.map((m) => (typeof m === 'string' ? m : m.displayName || m.name || '')).filter(Boolean)
      : [],
    lastMessage: last
      ? {
          // teams_list_chats returns lastMessageFrom as a plain display name
          // string; richer sources use sender.displayName.
          senderName:
            last.sender?.displayName || last.senderName || last.lastMessageFrom
            || (typeof last.sender === 'string' ? last.sender : '') || '',
          content: cleanContent(last.content ?? last.text ?? last.preview ?? ''),
          timestamp: last.time || last.timestamp || last.lastMessageTime || '',
        }
      : null,
  };
}
