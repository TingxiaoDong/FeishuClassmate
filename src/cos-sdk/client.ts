/**
 * ClassmateOS 平台客户端（AGENT_PLAN §2.1 / §2.2）。
 *
 * 只用 bot 令牌：
 *   - 代同学操作：X-Bot-Token + X-On-Behalf-Of（服务端按该同学权限 ∩ bot 作用域执行，并写审计）；
 *   - bot 自己发言：/bot/* 接口，只带 X-Bot-Token。
 * 不再需要冒用某位同学的登录令牌（旧的 CLASSMATE_OS_TOKEN）。
 */

import type { CosActor, CosRequest, CosResult, HttpMethod } from './types.js';

export interface CosClientOptions {
  /** 例如 http://localhost:8080/api/v1 */
  baseUrl: string;
  botToken: string;
  timeoutMs?: number;
  /** 测试注入。 */
  fetchImpl?: typeof fetch;
  /**
   * 没有指定代办对象时用谁（例如定时任务的「服务账号」）。不填则这类调用会被拒绝，
   * 避免机器人在不知道代谁的情况下动数据。
   */
  defaultUserId?: string;
}

export class CosClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: CosClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** 平台根地址（去掉 /api/v1），拼 upload_url 这类相对地址用。 */
  get origin(): string {
    return this.baseUrl.replace(/\/api\/v1$/, '');
  }

  /** userId 为 undefined 才用 defaultUserId；空字符串表示匿名（如 Temi 访客），一律拒绝。 */
  resolveUserId(actor?: CosActor): string | undefined {
    if (actor?.userId === '') return undefined;
    return actor?.userId ?? this.opts.defaultUserId;
  }

  async request<T = unknown>(method: HttpMethod, path: string, req: CosRequest = {}): Promise<CosResult<T>> {
    const headers: Record<string, string> = { 'X-Bot-Token': this.opts.botToken };
    if (!req.asBot) {
      const uid = this.resolveUserId(req.actor);
      if (!uid) {
        return { ok: false, status: 0, error: '不知道代表哪位同学操作（缺少发消息人身份）', code: 'NO_ACTOR' };
      }
      headers['X-On-Behalf-Of'] = uid;
    }
    if (req.actor?.sessionId) headers['X-Agent-Session'] = req.actor.sessionId;
    if (req.actor?.toolCallId) headers['X-Agent-Tool-Call'] = req.actor.toolCallId;
    if (req.actor?.confirmCardId) headers['X-Agent-Confirm'] = req.actor.confirmCardId;

    let body: string | undefined;
    if (req.body !== undefined && method !== 'GET') {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(req.body);
    }

    const url = new URL(`${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`);
    for (const [k, v] of Object.entries(req.query ?? {})) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.opts.timeoutMs ?? 30_000);
    const onAbort = () => ac.abort();
    if (req.signal?.aborted) ac.abort();
    req.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await this.fetchImpl(url, { method, headers, body, signal: ac.signal, redirect: 'error' });
      if (res.status === 204) return { ok: true, status: 204, data: undefined as T };
      const text = await res.text();
      let data: unknown = text;
      try {
        data = text ? JSON.parse(text) : undefined;
      } catch {
        /* 非 JSON 原样返回 */
      }
      if (!res.ok) {
        const d = (data && typeof data === 'object' ? data : {}) as { message?: string; code?: string; errors?: unknown };
        return {
          ok: false,
          status: res.status,
          error: d.message ?? `HTTP ${res.status}`,
          code: d.code,
          details: d.errors,
        };
      }
      return { ok: true, status: res.status, data: data as T };
    } catch (err) {
      const aborted = ac.signal.aborted;
      return {
        ok: false,
        status: 0,
        error: aborted ? '平台请求超时或被取消' : err instanceof Error ? err.message : String(err),
        code: aborted ? 'TIMEOUT' : 'NETWORK',
      };
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onAbort);
    }
  }

  get<T = unknown>(path: string, req?: Omit<CosRequest, 'body'>) {
    return this.request<T>('GET', path, req);
  }
  post<T = unknown>(path: string, body?: unknown, req?: CosRequest) {
    return this.request<T>('POST', path, { ...req, body });
  }
  patch<T = unknown>(path: string, body?: unknown, req?: CosRequest) {
    return this.request<T>('PATCH', path, { ...req, body });
  }
  put<T = unknown>(path: string, body?: unknown, req?: CosRequest) {
    return this.request<T>('PUT', path, { ...req, body });
  }
  delete<T = unknown>(path: string, req?: CosRequest) {
    return this.request<T>('DELETE', path, req);
  }

  /** 上传一段文本 / 字节为文件：申请签名地址 → 直传 → 返回 file_key。 */
  async uploadBytes(
    fileName: string,
    bytes: Uint8Array,
    opts: { contentType?: string; ref?: { type: 'doc' | 'task'; id: string }; actor?: CosActor } = {},
  ): Promise<CosResult<{ file_key: string; size: number }>> {
    const g = await this.post<{ file_key: string; upload_url: string }>(
      '/files/upload-url',
      { file_name: fileName, size: bytes.byteLength, content_type: opts.contentType, ref: opts.ref },
      { actor: opts.actor },
    );
    if (!g.ok) return g;
    const target = /^https?:/.test(g.data.upload_url) ? g.data.upload_url : `${this.origin}${g.data.upload_url}`;
    if (new URL(target).origin !== new URL(this.baseUrl).origin) return { ok: false, status: 0, error: '上传地址不属于平台', code: 'INVALID_UPLOAD_URL' };
    try {
      const res = await this.fetchImpl(target, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: bytes as unknown as NonNullable<RequestInit["body"]>,
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
        redirect: 'error',
      });
      if (!res.ok) return { ok: false, status: res.status, error: `上传失败 HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err), code: 'NETWORK' };
    }
    return { ok: true, status: 201, data: { file_key: g.data.file_key, size: bytes.byteLength } };
  }
}

/** 把 /tables/:table_key 这类模板填上参数（缺参数返回 undefined）。 */
export function fillPath(template: string, params: Record<string, unknown> = {}): string | undefined {
  let missing = false;
  const out = template.replace(/:([a-zA-Z_]+)/g, (_, k: string) => {
    const v = params[k];
    if (v === undefined || v === null || v === '') {
      missing = true;
      return '';
    }
    return encodeURIComponent(String(v));
  });
  return missing ? undefined : out;
}

/** 把具体路径（/tables/projects/records/rec_1）匹配回目录里的模板。 */
export function matchTemplate(template: string, concrete: string): boolean {
  const a = template.split('/').filter(Boolean);
  const b = concrete.split('?')[0].split('/').filter(Boolean);
  if (a.length !== b.length) return false;
  return a.every((seg, i) => seg.startsWith(':') ? b[i].length > 0 : seg === b[i]);
}
