// One-off device-code login. Run: npm run auth
// Prints a URL + code in the logs; open it on any device and approve.
import path from 'node:path';
import { getAuth } from '../teams/graph.js';
import { logger } from '../logging.js';

const dataDir = process.env.DATA_DIR || './data';
const auth = getAuth(path.resolve(dataDir));

auth.onDeviceCode = (response) => {
  console.log('\n──────────────────────────────────────────────');
  console.log('Open this URL in a browser:');
  console.log(`  ${response.verificationUri}`);
  console.log(`And enter code: ${response.userCode}`);
  console.log('──────────────────────────────────────────────\n');
};

try {
  await auth.deviceCodeLogin();
  const me = await auth.getMyUserId();
  console.log(`Authenticated as ${me}. Token cache stored in ${dataDir}/msal-cache.json`);
  process.exit(0);
} catch (err) {
  console.error(`Login failed: ${err.message}`);
  process.exit(1);
}
