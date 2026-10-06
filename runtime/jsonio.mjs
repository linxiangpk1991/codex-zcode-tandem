// Atomic JSON file IO shared by progress snapshots, control commands and the
// inbox: write to a unique temp file in the same directory, then rename.
// Readers therefore only ever observe complete documents.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}-${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n');
  renameSync(temp, file);
}

/** Parse a JSON file (BOM tolerant); returns null when missing/invalid. */
export function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}
