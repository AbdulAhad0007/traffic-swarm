// Prints a value for ADMIN_PASSWORD_HASH. Run: node frontend/scripts/hash-admin-password.mjs
// The password is typed at the prompt so it never lands in shell history.
import { createInterface } from 'node:readline';
import { hashPassword } from '../lib/password.js';

const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
const write = rl._writeToOutput?.bind(rl);
rl.question('Admin password (12+ characters): ', password => {
  rl.close();
  process.stdout.write('\n');
  if (password.length < 12) {
    console.error('Use at least 12 characters.');
    process.exit(1);
  }
  console.log(`ADMIN_PASSWORD_HASH=${hashPassword(password)}`);
});
if (process.stdin.isTTY && write) rl._writeToOutput = text => { if (text.includes('Admin password')) write(text); };
