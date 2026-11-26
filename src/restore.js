// Restores an encrypted Bants backup into a data folder.
//   node src/restore.js <backup dir> <new data dir> [YYYY-MM-DD]
// Asks for the passphrase (or reads BACKUP_PASSPHRASE). Uses the newest snapshot unless a date is given.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { decryptFile, keyFor } from './backup.js';

const [backupDir, outDir, date] = process.argv.slice(2);
if (!backupDir || !outDir) {
  console.log('Usage: node src/restore.js <backup dir> <new data dir> [YYYY-MM-DD]');
  process.exit(1);
}
let pass = process.env.BACKUP_PASSPHRASE;
if (!pass) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  pass = await rl.question('Backup passphrase: ');
  rl.close();
}
const k = keyFor(pass, backupDir);
const snaps = fs.readdirSync(path.join(backupDir, 'db')).filter((f) => f.endsWith('.db.enc')).sort();
const pick = date ? snaps.find((f) => f.includes(date)) : snaps.at(-1);
if (!pick) throw new Error('No matching database snapshot found');
fs.mkdirSync(path.join(outDir, 'media'), { recursive: true });
try {
  await decryptFile(path.join(backupDir, 'db', pick), path.join(outDir, 'bants.db'), k);
} catch (e) {
  console.error(/authenticate/.test(e.message) ? 'Wrong passphrase (or the backup file is damaged).' : e.message);
  process.exit(1);
}
console.log(`Database restored from ${pick}`);
let n = 0;
for (const f of fs.readdirSync(path.join(backupDir, 'media'))) {
  if (!f.endsWith('.enc')) continue;
  await decryptFile(path.join(backupDir, 'media', f), path.join(outDir, 'media', f.slice(0, -4)), k);
  n++;
}
console.log(`${n} media file(s) restored into ${outDir}`);
