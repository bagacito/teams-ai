import OpenAI from 'openai';

let client = null;
let model = null;

// Reusable OpenAI-compatible client for the internal PDM.AI router.
export function getAiClient(config = {}) {
  if (client) return client;
  const baseURL = config.baseUrl || process.env.PDM_AI_BASE_URL;
  const apiKey = config.apiKey || process.env.PDM_AI_API_KEY;
  model = config.model || process.env.PDM_AI_MODEL || 'DeepSeek-V4.1-Flash';
  if (!baseURL) throw new Error('PDM_AI_BASE_URL is not configured');
  if (!apiKey) throw new Error('PDM_AI_API_KEY is not configured');
  client = new OpenAI({ baseURL, apiKey });
  return client;
}

export function getAiModel() {
  return model || process.env.PDM_AI_MODEL || 'DeepSeek-V4.1-Flash';
}

export async function completeChat({ messages, temperature = 0.2, maxTokens = 500 }) {
  const openai = getAiClient();
  const completion = await openai.chat.completions.create({
    model: getAiModel(),
    messages,
    temperature,
    max_tokens: maxTokens,
  });
  return completion.choices?.[0]?.message?.content ?? '';
}

// Only used by tests to reset the singleton between cases.
export function resetAiClient() {
  client = null;
  model = null;
}
