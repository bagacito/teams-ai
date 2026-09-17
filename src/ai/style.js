// Builds the writing-style portion of the prompt from stored style examples.
// Style examples are messages the user actually wrote (or approved/edited) —
// never AI-generated text that was not sent.

export function buildStyleSection(styleExamples, maxExamples = 12) {
  const examples = (styleExamples || [])
    .slice(0, maxExamples)
    .map((e) => e.message)
    .filter((m) => m && m.trim());

  if (examples.length === 0) {
    return 'No writing examples are available yet. Write plainly and naturally.';
  }

  const quoted = examples.map((m) => `- ${m.replace(/\s+/g, ' ').trim()}`).join('\n');
  return `Examples of messages the user wrote (imitate this style):\n${quoted}`;
}
