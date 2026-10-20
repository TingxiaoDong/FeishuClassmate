/**
 * 二期迭代 4 R-IM-07：外部链接预览（后端抓标题和简介，前端只展示）。
 *
 * 防 SSRF：
 *   - 只允许 http / https，端口只允许 80 / 443；网址里不能带用户名密码；
 *   - 域名解析出的每一个地址都要是公网地址（拒绝回环、内网、链路本地、组播、保留、云厂商元数据等）；
 *   - 实际连接使用检查过的那个地址（自定义 lookup），防止「检查时是公网、连接时变内网」的 DNS 重绑定；
 *   - 不自动跟随跳转，每一跳都重新检查，最多 3 跳；
 *   - 超时 5 秒、正文最多读 512 KB、只解析 text/html；
 * 限流：每人每分钟最多 20 个链接；同一网址成功结果缓存 1 小时、失败缓存 10 分钟。
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

export interface LinkPreview {
  url: string;
  title: string;
  description: string;
}

export type LinkFetcher = (url: string) => Promise<LinkPreview | null>;

const MAX_BYTES = 512 * 1024;
const TIMEOUT_MS = 5000;
const MAX_REDIRECTS = 3;

/** 是否是可以访问的公网 IP。 */
export function isPublicIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    const [a, b] = p;
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
    if (a === 169 && b === 254) return false; // 链路本地 / 云元数据
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0 && (p[2] === 0 || p[2] === 2)) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (a === 198 && b === 51 && p[2] === 100) return false;
    if (a === 203 && b === 0 && p[2] === 113) return false;
    if (a >= 224) return false; // 组播、保留、广播
    return true;
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    if (x === '::' || x === '::1') return false;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
    if (mapped) return isPublicIp(mapped[1]);
    if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(x)) return false; // 十六进制写法的映射地址，一律拒绝
    if (/^f[cd]/.test(x)) return false; // ULA
    if (/^fe[89ab]/.test(x)) return false; // 链路本地
    if (/^ff/.test(x)) return false; // 组播
    if (/^(64:ff9b|2001:db8|2001:0db8|100::)/.test(x)) return false;
    if (x.startsWith('2002:')) return false; // 6to4 可能指向内网 IPv4
    return true;
  }
  return false;
}

/** 网址是否允许抓取（协议、端口、账号）。返回规范化后的 URL 或 null。 */
export function checkUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
  if (port !== 80 && port !== 443) return null;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return null;
  if (net.isIP(host) && !isPublicIp(host)) return null;
  return u;
}

/** 解析域名，所有地址都必须是公网地址；返回用于连接的地址。 */
async function resolvePublic(host: string): Promise<{ address: string; family: number }> {
  const bare = host.replace(/^\[|\]$/g, '');
  if (net.isIP(bare)) {
    if (!isPublicIp(bare)) throw new Error('blocked address');
    return { address: bare, family: net.isIPv6(bare) ? 6 : 4 };
  }
  const all = await dnsLookup(bare, { all: true, verbatim: true });
  if (!all.length || all.some((a) => !isPublicIp(a.address))) throw new Error('blocked address');
  return all[0];
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Math.min(parseInt(n, 16), 0x10ffff)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

/** 从 HTML 里取标题和简介（og 优先）。 */
export function parseHtmlMeta(html: string): { title: string; description: string } {
  const meta = (name: string) => {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*>`, 'i');
    const tag = re.exec(html)?.[0];
    const c = tag && /content=["']([^"']*)["']/i.exec(tag)?.[1];
    return c ? decodeEntities(c).trim() : '';
  };
  const title = meta('og:title') || decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').replace(/\s+/g, ' ').trim();
  const description = meta('og:description') || meta('description');
  return { title: title.slice(0, 200), description: description.slice(0, 300) };
}

function fetchOnce(u: URL): Promise<{ status: number; location?: string; type: string; body: string }> {
  return new Promise((resolve, reject) => {
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(
      u,
      {
        method: 'GET',
        timeout: TIMEOUT_MS,
        headers: { 'user-agent': 'ClassmateOS-LinkPreview/1.0', accept: 'text/html' },
        // 连接时再检查一次，并且只连检查过的地址
        lookup: ((hostname: string, opts: { all?: boolean }, cb: (...args: unknown[]) => void) => {
          resolvePublic(hostname).then(
            (a) => (opts?.all ? cb(null, [{ address: a.address, family: a.family }]) : cb(null, a.address, a.family)),
            (e: Error) => cb(e),
          );
        }) as unknown as net.LookupFunction,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const type = String(res.headers['content-type'] ?? '');
        if (status >= 300 && status < 400) {
          res.resume();
          return resolve({ status, location: res.headers.location, type, body: '' });
        }
        if (status !== 200 || !/text\/html|application\/xhtml/i.test(type)) {
          res.resume();
          return resolve({ status, type, body: '' });
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          chunks.push(c);
          if (size >= MAX_BYTES) res.destroy();
        });
        const done = () => resolve({ status, type, body: Buffer.concat(chunks).subarray(0, MAX_BYTES).toString('utf8') });
        res.on('end', done);
        res.on('close', done);
        res.on('error', done);
      },
    );
    const timer = setTimeout(() => req.destroy(new Error('timeout')), TIMEOUT_MS);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.on('close', () => clearTimeout(timer));
    req.end();
  });
}

/** 默认抓取器：失败、被拦截、不是网页时返回 null。 */
export const defaultLinkFetcher: LinkFetcher = async (raw) => {
  let u = checkUrl(raw);
  for (let hop = 0; u && hop <= MAX_REDIRECTS; hop++) {
    let res;
    try {
      res = await fetchOnce(u);
    } catch {
      return null;
    }
    if (res.location) {
      u = checkUrl(new URL(res.location, u).toString());
      continue;
    }
    if (!res.body) return null;
    const meta = parseHtmlMeta(res.body);
    if (!meta.title && !meta.description) return null;
    return { url: raw, title: meta.title || u.hostname, description: meta.description };
  }
  return null;
};

/** 从文本里找外部链接（去重，最多 n 个；内部链接由调用方排除）。 */
export function extractUrls(text: string, n = 3): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/https?:\/\/[^\s<>"'（）()【】，。！？、]+/gi)) {
    const url = m[0].replace(/[.,;:!?)\]]+$/, '');
    if (!out.includes(url)) out.push(url);
    if (out.length >= n) break;
  }
  return out;
}

/** 带缓存和限流的预览服务。 */
export class LinkPreviewService {
  private readonly cache = new Map<string, { at: number; value: LinkPreview | null }>();
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly fetcher: LinkFetcher, private readonly now: () => number = Date.now) {}

  /** 用户是否还有额度（每分钟 20 个链接）。 */
  private allow(userId: string): boolean {
    const t = this.now();
    const list = (this.hits.get(userId) ?? []).filter((x) => t - x < 60_000);
    if (list.length >= 20) {
      this.hits.set(userId, list);
      return false;
    }
    list.push(t);
    this.hits.set(userId, list);
    return true;
  }

  async previews(userId: string, urls: string[]): Promise<LinkPreview[]> {
    const out: LinkPreview[] = [];
    for (const url of urls) {
      if (!checkUrl(url)) continue;
      const c = this.cache.get(url);
      const t = this.now();
      if (c && t - c.at < (c.value ? 3600_000 : 600_000)) {
        if (c.value) out.push(c.value);
        continue;
      }
      if (!this.allow(userId)) break;
      const value = await this.fetcher(url).catch(() => null);
      this.cache.set(url, { at: t, value });
      if (this.cache.size > 5000) this.cache.delete(this.cache.keys().next().value!);
      if (value) out.push(value);
    }
    return out;
  }
}
