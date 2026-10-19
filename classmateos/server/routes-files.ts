/**
 * 文件与云盘（《前端接口需求文档》第 7 节）。
 */

import { fail, invalid, pageOffset, pageResult, pageSize, type Ctx } from './context.js';
import { fileKindOf, guessContentType, nowIso, type FileKind, type FileListEntry, type FileRecord } from './repo.js';

const KINDS = new Set<FileKind>(['image', 'doc', 'pdf', 'sheet', 'slide', 'other']);
/** 这些类型在 API 源上内联打开有 XSS 风险，一律按附件下载。 */
const UNSAFE_INLINE = /^(text\/html|application\/xhtml|image\/svg|text\/xml|application\/xml|application\/javascript|text\/javascript)/i;

function fileJson(e: FileListEntry | { file: FileRecord; source?: FileListEntry['source'] }) {
  const f = e.file;
  return {
    file_key: f.file_key,
    file_name: f.file_name,
    size: f.size,
    content_type: f.content_type,
    kind: f.kind,
    uploader_id: f.uploader_id,
    created_at: f.created_at,
    in_drive: f.in_drive,
    source: e.source ?? (f.in_drive ? { type: 'drive' } : undefined),
  };
}

function contentDisposition(type: 'inline' | 'attachment', fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export function registerFileRoutes(ctx: Ctx): void {
  const { app, repo, fileStore } = ctx;
  const maxMb = Math.round(ctx.maxFileSize / 1024 / 1024);

  app.post('/api/v1/files/upload-url', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const { file_name, size, content_type } = (req.body ?? {}) as {
      file_name?: unknown;
      size?: unknown;
      content_type?: unknown;
    };
    if (typeof file_name !== 'string' || !file_name.trim() || typeof size !== 'number') {
      return fail(reply, 400, '缺少 file_name 或 size');
    }
    if (file_name.length > 255) return invalid(reply, [{ field: 'file_name', message: '不能超过 255 字' }]);
    if (!Number.isFinite(size) || size < 0) return invalid(reply, [{ field: 'size', message: '必须是非负整数' }]);
    if (size > ctx.maxFileSize) return fail(reply, 413, `文件不能超过 ${maxMb} MB`, { code: 'FILE_TOO_LARGE' });
    const name = file_name.trim();
    const type =
      typeof content_type === 'string' && content_type && content_type !== 'application/octet-stream'
        ? content_type
        : guessContentType(name);
    const g = fileStore.requestUpload({ fileName: name, size, contentType: type });
    await repo.createFile({
      file_key: g.fileKey,
      file_name: name,
      size: Math.floor(size),
      content_type: type,
      kind: fileKindOf(name),
      uploader_id: me.sub,
      created_at: nowIso(),
      uploaded_at: null,
      in_drive: false,
      drive_added_at: null,
    });
    return { file_key: g.fileKey, upload_url: g.uploadUrl, expires_in: g.expiresIn };
  });

  // 签名直传（无需登录态，凭 URL 签名）
  app.put('/api/v1/files/:file_key/content', { bodyLimit: ctx.maxFileSize + 1024 }, async (req, reply) => {
    const { file_key } = req.params as { file_key: string };
    const { exp, sig } = req.query as { exp?: string; sig?: string };
    if (!exp || !sig || !fileStore.verify(file_key, 'put', Number(exp), sig)) {
      return fail(reply, 403, '上传地址无效或已过期');
    }
    const body = req.body;
    if (!Buffer.isBuffer(body)) return fail(reply, 400, '请求体必须是文件的原始字节');
    if (body.length > ctx.maxFileSize) return fail(reply, 413, `文件不能超过 ${maxMb} MB`, { code: 'FILE_TOO_LARGE' });
    await fileStore.write(file_key, body);
    // 只记录真实大小；content_type 以申请上传时为准（前端 PUT 固定发 octet-stream）
    await repo.markFileUploaded(file_key, body.length, nowIso());
    return reply.code(201).send({ file_key, size: body.length });
  });

  // 签名直取
  app.get('/api/v1/files/:file_key/content', async (req, reply) => {
    const { file_key } = req.params as { file_key: string };
    const { exp, sig, disposition } = req.query as { exp?: string; sig?: string; disposition?: string };
    if (!exp || !sig || !fileStore.verify(file_key, 'get', Number(exp), sig)) {
      return fail(reply, 403, '下载地址无效或已过期');
    }
    if (!fileStore.exists(file_key)) return fail(reply, 404, '文件不存在');
    const meta = await repo.getFile(file_key);
    const total = fileStore.sizeOf(file_key);
    const contentType = meta?.content_type ?? 'application/octet-stream';
    const fileName = meta?.file_name ?? file_key;
    const disp: 'inline' | 'attachment' =
      disposition === 'attachment' || UNSAFE_INLINE.test(contentType) ? 'attachment' : 'inline';

    reply
      .header('content-type', contentType)
      .header('content-disposition', contentDisposition(disp, fileName))
      .header('accept-ranges', 'bytes')
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, max-age=300');

    const range = req.headers.range;
    const m = typeof range === 'string' ? range.match(/^bytes=(\d*)-(\d*)$/) : null;
    if (m && (m[1] || m[2])) {
      let start: number;
      let end: number;
      if (!m[1]) {
        start = Math.max(0, total - Number(m[2]));
        end = total - 1;
      } else {
        start = Number(m[1]);
        end = m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
      }
      if (start > end || start >= total) {
        return reply.code(416).header('content-range', `bytes */${total}`).send();
      }
      reply.code(206).header('content-range', `bytes ${start}-${end}/${total}`).header('content-length', end - start + 1);
      return reply.send(fileStore.stream(file_key, { start, end }));
    }
    reply.header('content-length', total);
    return reply.send(fileStore.stream(file_key));
  });

  app.get('/api/v1/files/:file_key/download-url', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const { file_key } = req.params as { file_key: string };
    const { disposition } = req.query as { disposition?: string };
    const file = await repo.getFile(file_key);
    // 看不到的文件一律 404（不泄露存在性）
    if (!file || !file.uploaded_at || !(await ctx.canAccessFile(me, file))) return fail(reply, 404, '文件不存在');
    const grant = fileStore.getDownload(file_key, { disposition: disposition === 'attachment' ? 'attachment' : 'inline' });
    if (!grant) return fail(reply, 404, '文件不存在');
    return { download_url: grant.downloadUrl, expires_in: grant.expiresIn };
  });

  app.get('/api/v1/files', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const q = req.query as { scope?: string; kind?: string; keyword?: string; page_size?: string; page_token?: string };
    const scope = q.scope === 'mine' || q.scope === 'shared' ? q.scope : 'all';
    if (q.kind && !KINDS.has(q.kind as FileKind)) {
      return invalid(reply, [{ field: 'kind', message: '必须是以下之一：image、doc、pdf、sheet、slide、other' }]);
    }
    const limit = pageSize(q.page_size, 50, 500);
    const offset = pageOffset(q.page_token);
    const page = await repo.listFiles(me.sub, {
      scope,
      kind: (q.kind as FileKind) || undefined,
      keyword: q.keyword,
      limit,
      offset,
    });
    return pageResult(page.items.map(fileJson), page.total, offset);
  });

  app.get('/api/v1/files/usage', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    return { used: await repo.fileUsage(me.sub), quota: ctx.driveQuota };
  });

  app.post('/api/v1/files/:file_key/drive', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const { file_key } = req.params as { file_key: string };
    const file = await repo.getFile(file_key);
    if (!file || !(await ctx.canAccessFile(me, file))) return fail(reply, 404, '文件不存在');
    if (file.uploader_id !== me.sub) return fail(reply, 403, '只能把自己上传的文件加入云盘');
    if (!file.uploaded_at) return fail(reply, 409, '文件还没有上传完成');
    await repo.setFileDrive(file_key, true, nowIso());
    const fresh = (await repo.getFile(file_key))!;
    return fileJson({ file: fresh, source: { type: 'drive' } });
  });

  app.delete('/api/v1/files/:file_key', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const { file_key } = req.params as { file_key: string };
    const file = await repo.getFile(file_key);
    if (!file || !(await ctx.canAccessFile(me, file))) return fail(reply, 404, '文件不存在');
    if (file.uploader_id !== me.sub) return fail(reply, 403, '只有上传者可以删除');
    await repo.setFileDrive(file_key, false, nowIso());
    // 会话 / 表格里还引用着就只移出云盘；没人引用了才真正删除
    if ((await repo.listFileLinks(file_key)).length === 0) {
      await repo.deleteFile(file_key);
      await fileStore.remove(file_key).catch(() => undefined);
    }
    return reply.code(204).send();
  });
}
