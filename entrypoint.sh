#!/bin/sh
# Start as root only to fix ownership of mounted volumes, then drop to the
# unprivileged app user for the actual server process.
#
# IMPORTANT: APP_UID/APP_GID/TEAMS_HOSTNAME must match the machine where the
# msteams-mcp browser login was performed — the session store is encrypted
# with a key derived from hostname:username, and the container must present
# the same identity to decrypt it.
APP_UID="${APP_UID:-1001}"
APP_GID="${APP_GID:-1001}"
chown -R "$APP_UID:$APP_GID" /app/data /app/teams-session 2>/dev/null || true
exec setpriv --reuid="$APP_UID" --regid="$APP_GID" --init-groups node src/server.js
