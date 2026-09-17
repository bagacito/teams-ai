// OpenAI-compatible client for the internal PDM.AI router.
//
// NOTE: implemented with plain fetch instead of the `openai` SDK. The router
// sometimes returns 200 responses WITHOUT a Content-Type header, and the SDK
// then hands back the raw body as a string (no .choices), which silently
// turned into "empty reply" errors. Explicit parsing is more robust here.

const DEFAULT_MODEL = 'DeepSeek-V4.1-Flash';
const DEFAULT_TIMEOUT_MS = 120_000;

export function getAiModel() {
  return process.env.PDM_AI_MODEL || DEFAULT_MODEL;
}

export async function completeChat({
  messages,
  temperature = 0.2,
  maxTokens = 500,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  config = {},
} = {}) {
  const baseURL = (config.baseUrl || process.env.PDM_AI_BASE_URL || '').replace(/\/+$/, '');
  const apiKey = config.apiKey || process.env.PDM_AI_API_KEY;
  if (!baseURL) throw new Error('PDM_AI_BASE_URL is not configured');
  if (!apiKey) throw new Error('PDM_AI_API_KEY is not configured');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: config.model || getAiModel(),
        messages,
        temperature,
        max_tokens: maxTokens,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`AI request timed out after ${timeoutMs}ms`);
    }
    throw new Error(`AI request failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`AI request returned ${res.status}: ${text.slice(0, 200)}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`AI returned non-JSON body: ${text.slice(0, 200)}`);
  }
  if (parsed?.error) {
    throw new Error(`AI error: ${typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed.error).slice(0, 200)}`);
  }
  const choice = parsed.choices?.[0];
  const content = choice?.message?.content ?? '';
  // Reasoning models can burn the entire budget on the reasoning phase and
  // write nothing. Surface that clearly instead of reporting "empty reply".
  if (!content && choice?.finish_reason === 'length') {
    throw new Error(`AI hit the max_tokens (${maxTokens}) limit during reasoning before writing any content`);
  }
  return content;
}

// Kept for API compatibility (was used by tests to reset the old singleton).
export function resetAiClient() {}
