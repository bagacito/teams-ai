export function createSubscriptionRepo(db) {
  const stmts = {
    upsert: db.prepare(`
      INSERT INTO subscriptions (teams_chat_id, subscription_id, resource, status, expires_at)
      VALUES (@teams_chat_id, @subscription_id, @resource, @status, @expires_at)
      ON CONFLICT(teams_chat_id) DO UPDATE SET
        subscription_id = excluded.subscription_id,
        resource = excluded.resource,
        status = excluded.status,
        expires_at = excluded.expires_at,
        last_error = NULL
    `),
    all: db.prepare('SELECT * FROM subscriptions ORDER BY created_at DESC'),
    get: db.prepare('SELECT * FROM subscriptions WHERE id = ?'),
    byChatId: db.prepare('SELECT * FROM subscriptions WHERE teams_chat_id = ?'),
    bySubscriptionId: db.prepare('SELECT * FROM subscriptions WHERE subscription_id = ?'),
    setRenewed: db.prepare(
      "UPDATE subscriptions SET expires_at = ?, last_renewed_at = datetime('now'), status = 'active', last_error = NULL WHERE id = ?",
    ),
    setError: db.prepare('UPDATE subscriptions SET status = ?, last_error = ? WHERE id = ?'),
    remove: db.prepare('DELETE FROM subscriptions WHERE id = ?'),
  };

  return {
    save({ teamsChatId, subscriptionId, resource, status, expiresAt }) {
      stmts.upsert.run({
        teams_chat_id: teamsChatId,
        subscription_id: subscriptionId,
        resource: resource ?? '',
        status: status ?? 'active',
        expires_at: expiresAt,
      });
      return stmts.byChatId.get(teamsChatId);
    },
    list() {
      return stmts.all.all();
    },
    get(id) {
      return stmts.get.get(id);
    },
    getByChatId(chatId) {
      return stmts.byChatId.get(chatId);
    },
    getBySubscriptionId(subId) {
      return stmts.bySubscriptionId.get(subId);
    },
    markRenewed(id, expiresAt) {
      stmts.setRenewed.run(expiresAt, id);
    },
    markError(id, status, error) {
      stmts.setError.run(id, status, String(error).slice(0, 500));
    },
    remove(id) {
      stmts.remove.run(id);
    },
  };
}
