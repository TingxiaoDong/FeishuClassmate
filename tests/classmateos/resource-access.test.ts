import { describe, it, expect } from 'vitest';
import { MemoryRepo } from '../../classmateos/server/memory-repo.js';
import { buildApp } from '../../classmateos/server/app.js';
import { permissionFlags, resourceRole, validateGrant } from '../../classmateos/server/resource-access.js';
import type { ResourceGrant } from '../../classmateos/server/repo.js';

const grant = (): ResourceGrant => ({ resource_type: 'doc', resource_id: 'doc_test', owner_id: 'owner', visibility: 'off', members: [], version: 1 });
describe('迭代2共用授权基础', () => {
  it('原子版本检查与返回副本隔离', async () => {
    const repo = new MemoryRepo();
    expect(await repo.saveResourceGrant(grant(), 0)).toBe(true);
    expect(await repo.saveResourceGrant(grant(), 0)).toBe(false);
    const got = (await repo.getResourceGrant('doc', 'doc_test'))!;
    got.members.push({ member_type: 'user', member_id: 'outsider', role: 'manager' });
    expect((await repo.getResourceGrant('doc', 'doc_test'))!.members).toEqual([]);
    const results = await Promise.all([repo.saveResourceGrant(grant(), 1), repo.saveResourceGrant(grant(), 1)]);
    expect(results.sort()).toEqual([false, true]);
    expect((await repo.getResourceGrant('doc', 'doc_test'))!.version).toBe(2);
    expect(await repo.getResourceGrant('table', 'doc_test')).toBeUndefined();
  });
  it('成员与部门按最高角色合并，关闭分享不授予陌生人权限', async () => {
    const repo = new MemoryRepo();
    const app = await buildApp({ repo, secret: 'test', notificationScanner: false, users: [
      { user_id: 'owner', name: '所有者', password: 'pw', role: 'member' },
      { user_id: 'reader', name: '协作者', password: 'pw', role: 'member', department: '研发' },
      { user_id: 'stranger', name: '其他成员', password: 'pw', role: 'member' },
    ] });
    try {
      const g = grant();
      expect(await resourceRole(repo, 'owner', g)).toBe('manager');
      expect(await resourceRole(repo, 'stranger', g)).toBeNull();
      g.members = [{ member_type: 'department', member_id: '研发', role: 'viewer' }, { member_type: 'user', member_id: 'reader', role: 'editor' }];
      expect(await resourceRole(repo, 'reader', g)).toBe('editor');
      expect(await validateGrant(repo, g)).toEqual([]);
      await repo.updateUser('reader', { disabled: true });
      expect(await resourceRole(repo, 'reader', g)).toBeNull();
      expect((await validateGrant(repo, g)).length).toBeGreaterThan(0);
      g.members = [{ member_type: 'user', member_id: 'owner', role: 'viewer' }];
      expect((await validateGrant(repo, g)).some(e => e.message.includes('降权'))).toBe(true);
    } finally { await app.close(); }
  });
  it('角色映射不能把查看者当作编辑者', () => {
    expect(permissionFlags(null)).toEqual({ can_view: false, can_comment: false, can_edit: false, can_manage: false, can_delete: false });
    expect(permissionFlags('viewer').can_edit).toBe(false);
    expect(permissionFlags('commenter').can_comment).toBe(true);
    expect(permissionFlags('editor').can_manage).toBe(false);
    expect(permissionFlags('manager').can_delete).toBe(true);
  });
});
