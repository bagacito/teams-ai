import crypto from 'node:crypto';

// Password stored as scrypt hash. Never store plaintext.
const N = 16384, R = 8, P = 1, KEYLEN = 64;

export function createAdminAuthRepo(db) {
  function hash(password) {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(password, salt, KEYLEN, { N, r: R, p: P });
    return `scrypt$${N}$${R}$${P}$${salt.toString('hex')}$${hash.toString('hex')}`;
  }

  function verify(password, stored) {
    try {
      const [scheme, n, r, p, saltHex, hashHex] = String(stored).split('$');
      if (scheme !== 'scrypt') return false;
      const salt = Buffer.from(saltHex, 'hex');
      const expected = Buffer.from(hashHex, 'hex');
      const actual = crypto.scryptSync(password, salt, expected.length, {
        N: Number(n), r: Number(r), p: Number(p),
      });
      return crypto.timingSafeEqual(actual, expected);
    } catch {
      return false;
    }
  }

  const stmts = {
    get: db.prepare('SELECT * FROM admin_auth WHERE id = 1'),
    upsert: db.prepare('INSERT INTO admin_auth (id, password_hash) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET password_hash = excluded.password_hash'),
  };

  return {
    // Initialize from ADMIN_PASSWORD env on first run only.
    ensureInitialized(envPassword) {
      const row = stmts.get.get();
      if (row) return { created: false };
      if (!envPassword || envPassword.length < 16) {
        throw new Error(
          'ADMIN_PASSWORD not configured or too short. Set a strong password (min 16 chars) in the environment.',
        );
      }
      stmts.upsert.run(hash(envPassword));
      return { created: true };
    },
    verifyPassword(password) {
      const row = stmts.get.get();
      if (!row) return false;
      return verify(password, row.password_hash);
    },
    hasPassword() {
      return stmts.get.get() !== undefined;
    },
  };
}
