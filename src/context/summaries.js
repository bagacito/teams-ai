import { completeChat } from '../ai/client.js';
import { stripHtml } from './history.js';
import { logger } from '../logging.js';

// Conversation summaries: factual facts about the chat only.
// Writing-style observations are deliberately EXCLUDED — style lives in
// style_examples, facts live here. The two must never mix.

const SUMMARY_TRIGGER_DEFAULT = 40;

const SUMMARY_SYSTEM = `Summarize a Microsoft Teams conversation as a concise factual brief.

Include only:
- decisions made
- unresolved questions
- responsibilities and owners
- relevant dates and deadlines
- project state
- important terminology, names and identifiers

Exclude:
- small talk and greetings
- writing style of any participant
- tone or personality observations
- opinions about how people write

Write it as short bullet points. Be precise. Use the conversation's language.`;

export async function summarizeChat({ chatId, messages, existingSummary, model }) {
  const transcript = messages
    .map((m) => `${m.isMe ? 'Me' : m.senderName || 'Them'}: ${stripHtml(m.content)}`)
    .join('\n');

  const userContent = [
    existingSummary ? `Previous summary:\n${existingSummary}\n` : '',
    `Conversation:\n${transcript}`,
    'Produce the updated summary.',
  ]
    .filter(Boolean)
    .join('\n\n');

  const summary = await completeChat({
    messages: [
      { role: 'system', content: SUMMARY_SYSTEM },
      { role: 'user', content: userContent },
    ],
    temperature: 0.1,
    maxTokens: 2000,
  });
  logger.info({ chatId }, 'conversation summary updated');
  return summary.trim();
}

export function summaryTriggerCount(settingsRepo) {
  return (
    Number(settingsRepo?.get('summary_trigger_message_count')) ||
    Number(process.env.SUMMARY_TRIGGER_MESSAGE_COUNT) ||
    SUMMARY_TRIGGER_DEFAULT
  );
}
