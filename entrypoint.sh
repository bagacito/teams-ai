#!/bin/sh
# Start as root only to fix ownership of mounted volumes, then drop to the
# unprivileged `node` user for the actual server process.
chown -R node:node /app/data 2>/dev/null || true
# Teams MCP session dir (browser-session credentials) must be writable by the
# node user; it is mounted from the host and never baked into the image.
chown -R node:node /app/teams-session 2>/dev/null || true
exec setpriv --reuid=node --regid=node --init-groups node src/server.js
