import fs from 'fs';
import path from 'path';
import os from 'os';

const MAX_LOG_FILES = 5;
const LOG_DIR = os.homedir();
const LOG_PREFIX = 'redbook-pull-';

function todayStr(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function getLogFiles(): string[] {
  try {
    return fs.readdirSync(LOG_DIR)
      .filter(f => f.startsWith(LOG_PREFIX) && f.endsWith('.log'))
      .map(f => path.join(LOG_DIR, f))
      .sort(); // ISO date format sorts lexicographically = chronologically
  } catch {
    return [];
  }
}

function rotateLogs(): void {
  const files = getLogFiles();
  if (files.length > MAX_LOG_FILES) {
    files.slice(0, files.length - MAX_LOG_FILES).forEach(f => {
      try { fs.unlinkSync(f); } catch {}
    });
  }
}

export const LOG_FILE = path.join(LOG_DIR, `${LOG_PREFIX}${todayStr()}.log`);

// 当天文件不存在时才写入启动标记，存在则追加
try {
  const exists = fs.existsSync(LOG_FILE);
  const header = `\n=== RedbookPull started ${new Date().toISOString()} ===\n`;
  if (exists) {
    fs.appendFileSync(LOG_FILE, header);
  } else {
    fs.writeFileSync(LOG_FILE, header.trimStart());
    rotateLogs();
  }
} catch {}

function fmt(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return `${arg.name}: ${arg.message}\n${arg.stack ?? ''}`;
  try { return JSON.stringify(arg); } catch { return String(arg); }
}

function write(level: string, args: unknown[]): void {
  const line = `[${new Date().toISOString()}] ${level} ${args.map(fmt).join(' ')}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch {}
}

export function log(...args: unknown[]): void {
  console.log(...args);
  write('INFO', args);
}

export function logError(...args: unknown[]): void {
  console.error(...args);
  write('ERROR', args);
}
