#!/usr/bin/env node
/**
 * Skleja cały kod projektu w jeden plik markdown do udostępnienia.
 *
 *   npm run codebase              -> codebase.md
 *   npm run codebase -- out.md    -> out.md
 *
 * Lista plików pochodzi z `git ls-files`, więc automatycznie respektuje
 * .gitignore — node_modules, dist i .env nigdy tu nie trafią. Bez gita
 * skrypt przechodzi na własne przeszukiwanie katalogów z tą samą listą
 * wykluczeń.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';

const OUTPUT = process.argv[2] ?? 'codebase.md';

/** Katalogi pomijane zawsze — także gdy ktoś je omyłkowo doda do gita. */
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'drizzle/meta', 'data', 'backups']);

/** Pliki bez wartości dla czytającego kod albo wprost niebezpieczne. */
const SKIP_FILES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', '.env', 'codebase.md']);

/** Binaria i zasoby — wrzucenie ich zaśmieciłoby plik. */
const SKIP_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svg',
  '.pdf', '.zip', '.gz', '.gpg', '.woff', '.woff2', '.ttf',
  '.mp3', '.ogg', '.mp4', '.xlsx', '.docx',
]);

const LANG = {
  '.ts': 'typescript', '.tsx': 'tsx', '.js': 'javascript', '.mjs': 'javascript',
  '.json': 'json', '.yml': 'yaml', '.yaml': 'yaml', '.sh': 'bash',
  '.sql': 'sql', '.md': 'markdown', '.env': 'ini', '.txt': 'text',
};

function languageFor(path) {
  const name = path.split('/').pop() ?? '';
  if (name === 'Dockerfile' || name.startsWith('Dockerfile.')) return 'dockerfile';
  if (name === '.gitignore' || name === '.dockerignore') return 'gitignore';
  if (name.startsWith('.env')) return 'ini';
  return LANG[extname(name)] ?? '';
}

function shouldSkip(path) {
  const parts = path.split('/');
  if (parts.some((p) => SKIP_DIRS.has(p))) return true;
  if (SKIP_DIRS.has(parts.slice(0, 2).join('/'))) return true;
  if (SKIP_FILES.has(parts.at(-1))) return true;
  if (SKIP_EXT.has(extname(path).toLowerCase())) return true;
  return false;
}

function listFromGit() {
  try {
    const out = execFileSync('git', ['ls-files'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').filter(Boolean);
  } catch {
    return null;
  }
}

function listFromDisk(dir = '.', acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = relative('.', full).split(sep).join('/');
    if (shouldSkip(rel)) continue;
    if (entry.isDirectory()) listFromDisk(full, acc);
    else if (entry.isFile()) acc.push(rel);
  }
  return acc;
}

/** Najpierw konfiguracja i dokumentacja, potem kod — czyta się w tej kolejności. */
const ORDER = ['README', 'package.json', 'tsconfig.json', 'docker-compose.yml', 'Dockerfile', '.env.example'];

function sortKey(path) {
  const idx = ORDER.findIndex((prefix) => path === prefix || path.startsWith(prefix));
  if (idx !== -1) return [0, idx, path];
  if (path.startsWith('src/')) return [1, 0, path];
  if (path.startsWith('docker/')) return [2, 0, path];
  if (path.startsWith('drizzle/')) return [3, 0, path];
  return [4, 0, path];
}

const files = (listFromGit() ?? listFromDisk())
  .filter((f) => !shouldSkip(f))
  .sort((a, b) => {
    const ka = sortKey(a);
    const kb = sortKey(b);
    return ka[0] - kb[0] || ka[1] - kb[1] || String(ka[2]).localeCompare(String(kb[2]));
  });

const chunks = [];
let totalLines = 0;

for (const file of files) {
  let content;
  try {
    content = readFileSync(file, 'utf-8');
  } catch {
    continue; // plik binarny albo bez uprawnien
  }
  if (content.includes('\0')) continue; // binarium mimo rozszerzenia

  const lines = content.split('\n').length;
  totalLines += lines;

  // Jesli plik sam zawiera ``` , uzywamy dluzszego ogrodzenia, zeby go nie urwac.
  const fence = content.includes('```') ? '````' : '```';

  chunks.push(`\n\n# Plik: ${file}\n${fence}${languageFor(file)}\n${content.replace(/\s*$/, '')}\n${fence}`);
}

const header = [
  '# GlovoBot — kod źródłowy',
  '',
  `Plików: ${files.length} · linii: ${totalLines.toLocaleString('pl-PL')}`,
  '',
  '## Struktura',
  '',
  '```',
  ...files,
  '```',
].join('\n');

writeFileSync(OUTPUT, header + chunks.join('') + '\n');

const kb = Math.round(statSync(OUTPUT).size / 1024);
console.log(`✅ ${OUTPUT} — ${files.length} plików, ${totalLines.toLocaleString('pl-PL')} linii, ${kb} KB`);