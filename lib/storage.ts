import fs from 'node:fs';
import path from 'node:path';
import { DataFile, DataFileSchema } from './types';

const DATA_PATH = path.join(process.cwd(), 'data', 'tasks.json');

function ensureFile(): void {
  const dir = path.dirname(DATA_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DATA_PATH)) {
    fs.writeFileSync(DATA_PATH, JSON.stringify({ tasks: [], reviews: [] }, null, 2));
  }
}

export function readData(): DataFile {
  ensureFile();
  const raw = fs.readFileSync(DATA_PATH, 'utf-8');
  return DataFileSchema.parse(JSON.parse(raw));
}

export function writeData(data: DataFile): void {
  ensureFile();
  const tmp = DATA_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DATA_PATH);
}
