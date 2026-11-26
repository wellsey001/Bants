// Nightly encrypted backups: a snapshot of the database plus every photo/video/file,
// each encrypted with AES-256-GCM using a key made from BACKUP_PASSPHRASE.
// Without the passphrase the backup is unreadable, so keep it somewhere safe.
//
// Layout in BACKUP_DIR:
//   salt.bin                       random salt for the passphrase (not secret)
//   db/bants-YYYY-MM-DD.db.enc     one database snapshot per night (the newest BACKUP_KEEP kept)
//   media/<id>.enc                 each media file once (they never change), removed when deleted
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { config } from './config.js';
import { db } from './db.js';

const MAGIC = Buffer.from('BANTSENC1');
const status = { enabled: false, lastAt: null, lastError: null, running: false, files: 0 };
let key = null;

export const backupStatus = () => ({ ...status, enabled: !!(config.backupDir && config.backupPassphrase) });

function getKey() {
  if (key) return key;
  fs.mkdirSync(config.backupDir, { recursive: true });
  const saltFile = path.join(config.backupDir, 'salt.bin');
  if (!fs.existsSync(saltFile)) fs.writeFileSync(saltFile, crypto.randomBytes(16));
  key = crypto.scryptSync(config.backupPassphrase, fs.readFileSync(saltFile), 32, { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  return key;
}

/** Encrypts one file: MAGIC | 12-byte IV | ciphertext | 16-byte tag. Writes atomically. */
export async function encryptFile(src, dest, k = getKey()) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', k, iv);
  const tmp = dest + '.part';
  const out = fs.createWriteStream(tmp);
  out.write(MAGIC);
  out.write(iv);
  await pipeline(fs.createReadStream(src), cipher, out, { end: false }).catch(async (e) => {
    out.destroy();
    throw e;
  });
  await new Promise((resolve, reject) => out.end(cipher.getAuthTag(), (e) => (e ? reject(e) : resolve())));
  fs.renameSync(tmp, dest);
}

/** Decrypts a backup file (used by restore.js). Throws if the passphrase is wrong or the file was changed. */
export async function decryptFile(src, dest, k) {
  const { size } = fs.statSync(src);
  const fd = fs.openSync(src, 'r');
  const head = Buffer.alloc(MAGIC.length + 12);
  fs.readSync(fd, head, 0, head.length, 0);
  const tag = Buffer.alloc(16);
  fs.readSync(fd, tag, 0, 16, size - 16);
  fs.closeSync(fd);
  if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error(`${src} isn't a Bants backup file`);
  const decipher = crypto.createDecipheriv('aes-256-gcm', k, head.subarray(MAGIC.length));
  decipher.setAuthTag(tag);
  await pipeline(fs.createReadStream(src, { start: head.length, end: size - 17 }), decipher, fs.createWriteStream(dest));
}

export function keyFor(passphrase, backupDir) {
  const salt = fs.readFileSync(path.join(backupDir, 'salt.bin'));
  return crypto.scryptSync(passphrase, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
}

export async function runBackup() {
  if (!config.backupDir || !config.backupPassphrase) throw new Error('Set BACKUP_DIR and BACKUP_PASSPHRASE to turn backups on');
  if (status.running) return backupStatus();
  status.running = true;
  try {
    const k = getKey();
    const dbDir = path.join(config.backupDir, 'db');
    const mediaOut = path.join(config.backupDir, 'media');
    fs.mkdirSync(dbDir, { recursive: true });
    fs.mkdirSync(mediaOut, { recursive: true });

    // 1. Database: a consistent snapshot, then encrypt it.
    const snap = path.join(config.dataDir, `.backup-${Date.now()}.db`);
    db.exec(`VACUUM INTO '${snap.replace(/'/g, "''")}'`);
    const day = new Date().toISOString().slice(0, 10);
    try {
      await encryptFile(snap, path.join(dbDir, `bants-${day}.db.enc`), k);
    } finally {
      fs.rmSync(snap, { force: true });
    }
    const snaps = fs.readdirSync(dbDir).filter((f) => f.endsWith('.db.enc')).sort();
    for (const old of snaps.slice(0, Math.max(0, snaps.length - config.backupKeep))) fs.rmSync(path.join(dbDir, old), { force: true });

    // 2. Media: only files we haven't backed up yet; drop ones that were deleted.
    const srcDir = path.join(config.dataDir, 'media');
    const have = new Set(fs.existsSync(srcDir) ? fs.readdirSync(srcDir) : []);
    let added = 0;
    for (const id of have) {
      const dest = path.join(mediaOut, `${id}.enc`);
      if (!fs.existsSync(dest)) {
        await encryptFile(path.join(srcDir, id), dest, k);
        added++;
      }
    }
    for (const f of fs.readdirSync(mediaOut)) {
      if (f.endsWith('.part') || (f.endsWith('.enc') && !have.has(f.slice(0, -4)))) fs.rmSync(path.join(mediaOut, f), { force: true });
    }
    status.files = added;
    status.lastAt = Date.now();
    status.lastError = null;
    console.log(`Backup done: database snapshot + ${added} new media file(s)`);
  } catch (e) {
    status.lastError = e.message;
    console.error('Backup failed:', e);
    throw e;
  } finally {
    status.running = false;
  }
  return backupStatus();
}

/** Runs once a night at BACKUP_HOUR (server time), and once shortly after start-up. */
export function scheduleBackups() {
  if (!config.backupDir || !config.backupPassphrase) return;
  const tick = () => runBackup().catch(() => {});
  setTimeout(tick, 60_000).unref();
  const next = () => {
    const now = new Date();
    const at = new Date(now);
    at.setHours(config.backupHour, 0, 0, 0);
    if (at <= now) at.setDate(at.getDate() + 1);
    setTimeout(() => {
      tick();
      next();
    }, at - now).unref();
  };
  next();
}
