/* Reset a local MRDCL portal account password from the trusted server console. */
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const username = String(process.argv[2] || '').trim().toLowerCase();
const password = process.env.MRDCL_NEW_PASSWORD || '';
if (!/^[a-z0-9._-]{3,40}$/.test(username) || password.length < 10) {
  console.error('Usage: set MRDCL_NEW_PASSWORD to a 10+ character password, then run: node scripts/reset_password.js <user-id>');
  process.exit(1);
}
const db = new DatabaseSync(path.join(__dirname, '..', 'database', 'mrdcl-surveys.db'));
const salt = crypto.randomBytes(16).toString('hex');
const digest = crypto.scryptSync(password, salt, 64).toString('hex');
const result = db.prepare('UPDATE users SET password_hash=?, password_salt=? WHERE username=?').run(digest, salt, username);
if (!result.changes) { console.error(`No account named "${username}" was found.`); process.exit(1); }
console.log(`Password reset for ${username}.`);
