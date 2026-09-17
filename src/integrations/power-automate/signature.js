import crypto from 'node:crypto';

// Shared-secret authentication helpers.
// Secrets are never logged and compared in constant time.

export function extractBearerToken(authHeader) {
  if (!authHeader || typeof authHeader !== 'string') return null;
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

// Timing-safe comparison; returns false for missing/mismatched secrets.
export function secretsMatch(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) {
    // Length leak is unavoidable, but do a dummy compare to keep timing flat.
    crypto.timingSafeEqual(b, b);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

// Full inbound auth check: Bearer header against POWER_AUTOMATE_INBOUND_SECRET.
export function verifyInboundAuth(req, expectedSecret) {
  if (!expectedSecret) return false; // not configured -> refuse everything
  const token = extractBearerToken(req.headers.authorization);
  // Secondary accepted header for convenience; Bearer remains primary.
  const alt = req.headers['x-power-automate-secret'];
  return secretsMatch(token, expectedSecret) || secretsMatch(alt, expectedSecret);
}
