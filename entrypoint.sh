#!/bin/sh
# Start as root only to fix ownership of the mounted data dir, then drop to
# the unprivileged `node` user for the actual server process.
chown -R node:node /app/data 2>/dev/null || true
exec setpriv --reuid=node --regid=node --init-groups node src/server.js
