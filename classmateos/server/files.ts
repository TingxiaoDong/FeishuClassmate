/**
 * 文件存储（PLAN §2.1 文件/富媒体）。
 *
 * 抽象与 MinIO 预签名语义对齐：客户端先申请 upload-url，直传存储，
 * 再凭 file_key 换 download-url。P1 用本地磁盘实现（LocalFileStore），
 * 上传/下载 URL 是本平台端点 + HMAC 签名；生产切 MinIO 时换成真 S3
 * 预签名（S3FileStore 接口预留，MinIO 实例就绪后实现）。
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, statSync, type ReadStream } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface UploadGrant {
  fileKey: string;
  uploadUrl: string;
  expiresIn: number;
}

export interface DownloadGrant {
  downloadUrl: string;
  expiresIn: number;
}

export interface FileStore {
  requestUpload(params: { fileName: string; size: number; contentType?: string }): UploadGrant;
  getDownload(fileKey: string): DownloadGrant | undefined;
}

const b64u = (buf: Buffer | string): string =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * 本地磁盘实现：签名 URL 指回本平台 /files/:key/content 端点。
 * 签名 = HMAC(fileKey, op, exp)，服务端校验后放行——与 S3 预签名同构。
 */
export class LocalFileStore implements FileStore {
  constructor(
    private readonly opts: {
      dir: string;
      /** URL 前缀，如 /api/v1/files（相对路径，客户端拼 origin）。 */
      urlPrefix: string;
      secret: string;
      ttlMs?: number;
    },
  ) {
    mkdirSync(opts.dir, { recursive: true });
  }

  private sign(fileKey: string, op: 'put' | 'get', exp: number): string {
    return b64u(createHmac('sha256', this.opts.secret).update(`${fileKey}.${op}.${exp}`).digest());
  }

  /** 服务端校验签名（content 端点调用）。 */
  verify(fileKey: string, op: 'put' | 'get', exp: number, sig: string): boolean {
    if (exp < Date.now()) return false;
    const expect = this.sign(fileKey, op, exp);
    const a = Buffer.from(sig);
    const b = Buffer.from(expect);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  requestUpload(params: { fileName: string; size: number; contentType?: string }): UploadGrant {
    const fileKey = `f_${randomUUID()}_${params.fileName.replace(/[^\w.-]/g, '_').slice(-64)}`;
    const ttl = this.opts.ttlMs ?? 3600_000;
    const exp = Date.now() + ttl;
    return {
      fileKey,
      uploadUrl: `${this.opts.urlPrefix}/${encodeURIComponent(fileKey)}/content?exp=${exp}&sig=${this.sign(fileKey, 'put', exp)}`,
      expiresIn: Math.floor(ttl / 1000),
    };
  }

  getDownload(fileKey: string, opts: { disposition?: 'inline' | 'attachment' } = {}): DownloadGrant | undefined {
    if (!existsSync(this.pathOf(fileKey))) return undefined;
    // 前端会缓存下载地址 4 分钟，有效期至少 5 分钟
    const ttl = Math.max(this.opts.ttlMs ?? 3600_000, 300_000);
    const exp = Date.now() + ttl;
    const disp = opts.disposition === 'attachment' ? '&disposition=attachment' : '';
    return {
      downloadUrl: `${this.opts.urlPrefix}/${encodeURIComponent(fileKey)}/content?exp=${exp}&sig=${this.sign(fileKey, 'get', exp)}${disp}`,
      expiresIn: Math.floor(ttl / 1000),
    };
  }

  pathOf(fileKey: string): string {
    // fileKey 由本服务生成（前缀 f_ + uuid + 净化文件名），仍防一次路径穿越。
    if (!/^f_[\w-]+_[\w.-]+$/.test(fileKey) || fileKey.includes('..')) {
      throw new Error(`invalid fileKey: ${fileKey}`);
    }
    return join(this.opts.dir, fileKey);
  }

  async write(fileKey: string, data: Buffer): Promise<void> {
    await mkdir(this.opts.dir, { recursive: true });
    await writeFile(this.pathOf(fileKey), data);
  }

  async read(fileKey: string): Promise<Buffer | undefined> {
    const p = this.pathOf(fileKey);
    if (!existsSync(p)) return undefined;
    return readFile(p);
  }

  sizeOf(fileKey: string): number {
    return statSync(this.pathOf(fileKey)).size;
  }

  exists(fileKey: string): boolean {
    try {
      return existsSync(this.pathOf(fileKey));
    } catch {
      return false;
    }
  }

  /** 流式读取（支持 Range：start/end 为闭区间字节下标）。 */
  stream(fileKey: string, range?: { start: number; end: number }): ReadStream {
    return createReadStream(this.pathOf(fileKey), range);
  }

  async remove(fileKey: string): Promise<void> {
    await rm(this.pathOf(fileKey), { force: true });
  }
}

/** MinIO/S3 实现占位：实例就绪后以 aws4 签名实现同一接口。 */
export class S3FileStore implements FileStore {
  constructor(private readonly endpoint: string) {
    void endpoint;
  }
  requestUpload(): UploadGrant {
    throw new Error('S3FileStore: MinIO 实例未配置（PLAN P1——MinIO 就绪后实现 aws4 预签名）');
  }
  getDownload(): DownloadGrant | undefined {
    throw new Error('S3FileStore: MinIO 实例未配置');
  }
}
