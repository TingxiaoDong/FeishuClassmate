#!/usr/bin/env node
/**
 * 生成 ClassmateOS 接口目录（AGENT_PLAN §2.1 L3）：src/cos-sdk/catalog.generated.ts
 *
 * 来源：
 *   - classmateos/server/*.ts 里真正注册的路由（app.get/post/patch/put/delete）——以代码为准，
 *     避免 openapi.yaml 落后于实现；
 *   - classmateos/openapi.yaml 里同路径同方法的 summary 作为说明（有就带上）。
 *
 * 排除 agent 不该直接调用的：登录、bot 专用、WebSocket、签名直传、设备、控制台。
 * 用法：node scripts/gen-cos-catalog.mjs [--check]   --check 时只比较，不一致退出码 1（CI 用）。
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const serverDir = join(root, 'classmateos/server');
const outFile = join(root, 'src/cos-sdk/catalog.generated.ts');

const EXCLUDE = [
  /^\/auth\//,
  /^\/bot\//,
  /\/ws$/,
  /^\/devices/,
  /^\/health$/,
  /^\/capabilities$/,
  /\/collab$/,
  /^\/files\/:file_key\/content$/,
  /\$\{/,
];

const GROUPS = [
  ['/tables', 'table'],
  ['/docs', 'doc'],
  ['/calendar', 'calendar'],
  ['/tasklists', 'task'],
  ['/tasks', 'task'],
  ['/chats', 'im'],
  ['/messages', 'im'],
  ['/files', 'drive'],
  ['/users', 'contact'],
  ['/notifications', 'notify'],
  ['/favorites', 'im'],
  ['/dashboard', 'workbench'],
];

export function scanRoutes() {
  const re = /app\.(get|post|patch|put|delete)(?:<[^>]*>)?\(\s*['`]([^'`]+)['`]/g;
  const seen = new Map();
  for (const f of readdirSync(serverDir).filter((n) => n.endsWith('.ts')).sort()) {
    const src = readFileSync(join(serverDir, f), 'utf8');
    for (const m of src.matchAll(re)) {
      const full = m[2];
      if (!full.startsWith('/api/v1/')) continue;
      const path = full.slice('/api/v1'.length);
      if (EXCLUDE.some((r) => r.test(path))) continue;
      const method = m[1].toUpperCase();
      seen.set(`${method} ${path}`, { method, path, file: f });
    }
  }
  return [...seen.values()];
}

function openapiSummaries() {
  const text = readFileSync(join(root, 'classmateos/openapi.yaml'), 'utf8');
  const out = new Map();
  let curPath = null;
  let curMethod = null;
  for (const line of text.split('\n')) {
    let m = line.match(/^ {2}(\/[^:]+):\s*$/);
    if (m) {
      curPath = m[1].replace(/\{([^}]+)\}/g, ':$1');
      curMethod = null;
      continue;
    }
    m = line.match(/^ {4}(get|post|patch|put|delete):\s*$/);
    if (m && curPath) {
      curMethod = m[1].toUpperCase();
      continue;
    }
    m = line.match(/^ {6}summary:\s*(.+)$/);
    if (m && curPath && curMethod) out.set(`${curMethod} ${curPath}`, m[1].trim().replace(/^['"]|['"]$/g, ''));
  }
  return out;
}

export function buildCatalog() {
  const sums = openapiSummaries();
  return scanRoutes()
    .map((r) => ({
      method: r.method,
      path: r.path,
      group: GROUPS.find(([p]) => r.path.startsWith(p))?.[1] ?? 'other',
      summary: sums.get(`${r.method} ${r.path}`) ?? '',
    }))
    .sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

function render(items) {
  return `/* 自动生成，请勿手改：node scripts/gen-cos-catalog.mjs */
import type { CosApiEntry } from './types.js';

export const COS_API_CATALOG: CosApiEntry[] = ${JSON.stringify(items, null, 2)};
`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const text = render(buildCatalog());
  if (process.argv.includes('--check')) {
    let old = '';
    try {
      old = readFileSync(outFile, 'utf8');
    } catch {}
    if (old !== text) {
      console.error('catalog.generated.ts 已过期，请运行 node scripts/gen-cos-catalog.mjs');
      process.exit(1);
    }
    console.log('catalog up to date');
  } else {
    writeFileSync(outFile, text);
    console.log(`wrote ${outFile}`);
  }
}
