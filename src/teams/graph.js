import { TeamsAuth } from './auth.js';
import { logger } from '../logging.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';

// Minimal Graph REST client for delegated auth.
let authInstance = null;

export function getAuth(dataDir) {
  if (!authInstance) authInstance = new TeamsAuth({ dataDir });
  return authInstance;
}

export async function graphFetch(path, { method = 'GET', body, scopes } = {}) {
  const auth = getAuth();
  const token = await auth.getToken(scopes);
  const res = await fetch(`${GRAPH}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // Never log the token; the Authorization header is not included here.
    const err = new Error(`Graph ${method} ${path} failed: ${res.status}`);
    err.status = res.status;
    err.body = text.slice(0, 500);
    throw err;
  }
  if (res.status === 204) return null;
  return res.json();
}

// ---- Chat / message reads ----

export async function getChat(chatId) {
  return graphFetch(`/chats/${encodeURIComponent(chatId)}`);
}

export async function getChatMessages(chatId, { top = 50 } = {}) {
  const data = await graphFetch(
    `/chats/${encodeURIComponent(chatId)}/messages?$top=${top}&$orderby=createdDateTime desc`,
  );
  return data.value ?? [];
}

export async function getChatMessage(chatId, messageId) {
  return graphFetch(
    `/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}`,
  );
}

export async function getChatMembers(chatId) {
  const data = await graphFetch(`/chats/${encodeURIComponent(chatId)}/members`);
  return data.value ?? [];
}

export async function getMe() {
  return graphFetch('/me');
}
