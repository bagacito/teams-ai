// ntfy push notification provider.
// Privacy: detail mode controls how much message content leaves the box.
//   minimal: "New Teams reply waiting for approval - Alice - Project Alpha"
//   full:    includes original message and generated draft

export function formatNotification(draft, { chatName, detailMode, url, topic, server, token }) {
  if (!server || !topic) return null;

  const title = 'New Teams reply waiting for approval';
  let body;
  if (detailMode === 'full') {
    body =
      `${draft.sender_name || 'Unknown'} — ${chatName || 'chat'}\n\n` +
      `Original: ${oneLine(draft.original_message)}\n\n` +
      `Suggested reply:\n${draft.generated_reply}\n\n` +
      `Approve: ${url}`;
  } else {
    body = `${draft.sender_name || 'Unknown'} - ${chatName || 'chat'}\n${url}`;
  }

  return {
    server,
    topic,
    token,
    title,
    body,
    priority: 'default',
    tags: ['email'],
    click: url,
  };
}

function oneLine(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

export async function sendNtfy({ server, topic, token, title, body, priority, tags, click }) {
  const endpoint = `${server.replace(/\/+$/, '')}/${topic}`;
  const headers = {
    Title: title,
    Priority: priority,
    Tags: tags?.join(','),
    Click: click,
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`ntfy send failed: ${res.status} ${text.slice(0, 200)}`);
  }
}
