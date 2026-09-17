import fs from 'node:fs';
import path from 'node:path';
import { PublicClientApplication } from '@azure/msal-node';
import { logger } from '../logging.js';

// Delegated authentication via MSAL device-code flow.
// Token cache is persisted to the data dir so auth survives restarts.
// Access/refresh tokens are never logged.

const DEFAULT_SCOPES = ['Chat.ReadWrite', 'ChatMessage.Send', 'User.Read', 'offline_access'];

export function getGraphScopes() {
  const raw = process.env.MS_GRAPH_SCOPES || DEFAULT_SCOPES.join(',');
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

export function getMsalConfig({ cachePlugin } = {}) {
  const tenantId = process.env.MS_TENANT_ID;
  const clientId = process.env.MS_CLIENT_ID;
  if (!tenantId || !clientId) {
    throw new Error('MS_TENANT_ID and MS_CLIENT_ID must be configured');
  }
  const config = {
    auth: {
      clientId,
      authority: `https://login.microsoftonline.com/${tenantId}`,
    },
    system: {
      loggerOptions: {
        loggerCallback: () => {}, // silence msal logging (may contain sensitive info)
        piiLoggingEnabled: false,
        logLevel: 0,
      },
    },
  };
  if (cachePlugin) config.cache = { cachePlugin };
  return config;
}

export class TeamsAuth {
  constructor({ dataDir } = {}) {
    const dir = dataDir || process.env.DATA_DIR || './data';
    this.cachePath = path.join(dir, 'msal-cache.json');
    const cachePlugin = {
      readCache: async (ctx) => {
        const data = this.loadCache();
        if (data) ctx.tokenCache.deserialize(data);
      },
      writeCache: async (ctx) => {
        this.saveCache(ctx.tokenCache.serialize());
      },
    };
    this.client = new PublicClientApplication(getMsalConfig({ cachePlugin }));
    this.cache = this.client.getTokenCache();
  }

  loadCache() {
    try {
      return fs.readFileSync(this.cachePath, 'utf8');
    } catch {
      return null;
    }
  }

  saveCache(cache) {
    try {
      fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
      fs.writeFileSync(this.cachePath, cache, 'utf8');
      try {
        fs.chmodSync(this.cachePath, 0o600);
      } catch { /* non-fatal */ }
    } catch (err) {
      logger.error({ err: err.message }, 'failed to persist msal cache');
    }
  }

  async getToken(scopes) {
    const target = scopes || getGraphScopes();
    const accounts = await this.cache.getAllAccounts();
    if (accounts.length > 0) {
      try {
        const silent = await this.client.acquireTokenSilent({
          account: accounts[0],
          scopes: target,
        });
        return silent.accessToken;
      } catch (err) {
        logger.debug({ errName: err?.name }, 'silent token acquisition failed, falling back to device code');
      }
    }
    return this.deviceCodeLogin(target);
  }

  // Interactive device-code flow for first login from a headless server.
  deviceCodeLogin(scopes) {
    const target = scopes || getGraphScopes();
    return new Promise((resolve, reject) => {
      this.client
        .acquireTokenByDeviceCode({
          scopes: target,
          deviceCodeCallback: (deviceCodeResponse) => {
            // Safe to log: only a short user code + verification URL.
            logger.info(
              {
                userCode: deviceCodeResponse.userCode,
                verifyUrl: deviceCodeResponse.verificationUri,
              },
              'device code login required: open URL and enter code',
            );
            if (this.onDeviceCode) this.onDeviceCode(deviceCodeResponse);
          },
        })
        .then((result) => resolve(result.accessToken))
        .catch((err) => reject(err));
    });
  }

  async getMyUserId() {
    const token = await this.getToken(['User.Read']);
    const res = await fetch('https://graph.microsoft.com/v1.0/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`graph /me failed: ${res.status}`);
    const me = await res.json();
    return me.id;
  }

  isAuthenticated() {
    return this.loadCache() !== null;
  }
}
