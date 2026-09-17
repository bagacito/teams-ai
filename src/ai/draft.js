import { completeChat } from './client.js';
import { BEHAVIOR_INSTRUCTIONS, STYLE_INSTRUCTIONS } from './prompt.js';
import { buildStyleSection } from './style.js';

// Draft generation. This module produces reply text only.
// It MUST NOT send Teams messages — the only code path that sends is the
// approval route (routes/drafts.js) via the TeamsProvider send wrapper.
// See test/safety.test.mjs for enforcement.

export async function generateDraft({ context }) {
  const messages = buildPromptMessages(context);
  const raw = await completeChat({ messages, temperature: 0.2 });
  return cleanReply(raw);
}

export function buildPromptMessages(context) {
  const {
    styleExamples = [],
    globalContext = '',
    chatContext = '',
    summary = '',
    recentMessages = [],
    incomingMessage,
  } = context;

  const systemParts = [
    BEHAVIOR_INSTRUCTIONS,
    STYLE_INSTRUCTIONS,
    buildStyleSection(styleExamples),
  ];
  if (globalContext && globalContext.trim()) {
    systemParts.push(`Global context about the user:\n${globalContext.trim()}`);
  }

  const userParts = [];
  if (chatContext && chatContext.trim()) {
    userParts.push(`Context about this specific chat:\n${chatContext.trim()}`);
  }
  if (summary && summary.trim()) {
    userParts.push(`Summary of the earlier conversation:\n${summary.trim()}`);
  }
  if (recentMessages.length > 0) {
    const history = recentMessages
      .map((m) => `${m.isMe ? 'Me' : m.senderName || 'Them'}: ${m.content}`)
      .join('\n');
    userParts.push(`Recent conversation:\n${history}`);
  }
  userParts.push(
    `New message from ${incomingMessage.senderName || 'them'}:\n${incomingMessage.content}`,
  );
  userParts.push('Draft the reply text only.');

  return [
    { role: 'system', content: systemParts.join('\n\n') },
    { role: 'user', content: userParts.join('\n\n') },
  ];
}

// Strip code fences/whitespace the model may add despite instructions.
function cleanReply(text) {
  let out = String(text ?? '').trim();
  if (out.startsWith('```')) {
    out = out.replace(/^```[a-z]*\n?/, '').replace(/```$/, '').trim();
  }
  return out;
}
