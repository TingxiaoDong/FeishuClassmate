/**
 * files 端点测试：预签名上传/下载闭环、签名防篡、过期拒绝、404。
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../../classmateos/server/app.js';
import { LocalFileStore } from '../../classmateos/server/files.js';

const USERS = [{ user_id: 'ou_alice', name: 'alice', password: 'pw', role: 'admin' as const }];

async function setup() {
  const fileStore = new LocalFileStore({
    dir: mkdtempSync(join(tmpdir(), 'cos-files-test-')),
    urlPrefix: '/api/v1/files',
    secret: 's',
  });
  const app = await buildApp({ users: USERS, secret: 's', botToken: 'btok', fileStore });
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username: 'alice', password: 'pw' },
  });
  return { app, fileStore, token: login.json().access_token as string };
}

describe('files 端点（预签名 + 本地存储）', () => {
  it('完整闭环：申请上传 URL → 直传 → 换下载 URL → 取回字节', async () => {
    const { app, token } = await setup();
    const auth = { authorization: `Bearer ${token}` };

    const grant = await app.inject({
      method: 'POST',
      url: '/api/v1/files/upload-url',
      headers: auth,
      payload: { file_name: '讲解稿.md', size: 11, content_type: 'text/markdown' },
    });
    expect(grant.statusCode).toBe(200);
    const { file_key, upload_url } = grant.json();
    expect(file_key).toMatch(/^f_.+_.+\.md$/);

    const payload = Buffer.from('# 欢迎参观实验室');
    const up = await app.inject({ method: 'PUT', url: upload_url, payload });
    expect(up.statusCode).toBe(201);
    expect(up.json().size).toBe(payload.length);

    const dl = await app.inject({
      method: 'GET',
      url: `/api/v1/files/${encodeURIComponent(file_key)}/download-url`,
      headers: auth,
    });
    expect(dl.statusCode).toBe(200);

    const got = await app.inject({ method: 'GET', url: dl.json().download_url });
    expect(got.statusCode).toBe(200);
    expect(got.rawPayload.equals(payload)).toBe(true);
    await app.close();
  });

  it('签名防篡：改 sig/exp 被拒；未上传的 key 下载 404；接口要登录', async () => {
    const { app, token } = await setup();
    const auth = { authorization: `Bearer ${token}` };

    const grant = await app.inject({
      method: 'POST',
      url: '/api/v1/files/upload-url',
      headers: auth,
      payload: { file_name: 'a.bin', size: 1 },
    });
    const { file_key, upload_url } = grant.json();

    // 篡改签名
    const tampered = upload_url.replace(/sig=.{4}/, 'sig=AAAA');
    expect(
      (await app.inject({ method: 'PUT', url: tampered, payload: Buffer.from('x') })).statusCode,
    ).toBe(403);
    // 过期
    const expired = upload_url.replace(/exp=\d+/, 'exp=1');
    expect(
      (await app.inject({ method: 'PUT', url: expired, payload: Buffer.from('x') })).statusCode,
    ).toBe(403);
    // 未上传 → 下载 404
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/v1/files/${encodeURIComponent(file_key)}/download-url`,
          headers: auth,
        })
      ).statusCode,
    ).toBe(404);
    // 未登录
    expect((await app.inject({ method: 'POST', url: '/api/v1/files/upload-url', payload: {} })).statusCode).toBe(401);
    await app.close();
  });

  it('fileKey 路径穿越防护', () => {
    const store = new LocalFileStore({ dir: mkdtempSync(join(tmpdir(), 'cos-fs-')), urlPrefix: '/f', secret: 's' });
    expect(() => store.pathOf('../../etc/passwd')).toThrow(/invalid fileKey/);
  });
});
