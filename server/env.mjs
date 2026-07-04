import fs from 'node:fs';
import path from 'node:path';

const dotenvCache = new Map();

const dotenvCandidates = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), '../dff-workflow-builder/.env'),
  path.resolve(process.cwd(), '../dashboards-poultry/.env'),
  path.resolve(process.cwd(), '../timesheets/server/.env'),
  path.resolve(process.cwd(), '../timesheets/.env'),
];

const localDotenvCandidates = [path.resolve(process.cwd(), '.env')];

function parseDotenvLine(line) {
  const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  if (!match) return null;
  const [, key, rawValue] = match;
  let value = rawValue.trim();

  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }

  return { key, value: value.replace(/\\n/g, '\n') };
}

function readDotenvFile(filePath) {
  if (dotenvCache.has(filePath)) return dotenvCache.get(filePath);

  const values = new Map();
  if (!fs.existsSync(filePath)) {
    dotenvCache.set(filePath, values);
    return values;
  }

  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const parsed = parseDotenvLine(line);
    if (parsed) values.set(parsed.key, parsed.value);
  }

  dotenvCache.set(filePath, values);
  return values;
}

export function envValue(key, fallback = '') {
  const direct = String(process.env[key] || '').trim();
  if (direct) return direct;

  for (const filePath of dotenvCandidates) {
    const value = readDotenvFile(filePath).get(key);
    if (String(value || '').trim()) return String(value).trim();
  }

  return fallback;
}

export function localEnvValue(key, fallback = '') {
  const direct = String(process.env[key] || '').trim();
  if (direct) return direct;

  for (const filePath of localDotenvCandidates) {
    const value = readDotenvFile(filePath).get(key);
    if (String(value || '').trim()) return String(value).trim();
  }

  return fallback;
}

export function envCandidatesForDebug() {
  return dotenvCandidates.map((filePath) => ({
    path: filePath,
    exists: fs.existsSync(filePath),
  }));
}
