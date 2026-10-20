/**
 * 云文档：文件夹、收藏、回收站（二期 R-DC-05，开关 doc.folders）。
 *
 * 存储（通用实体表，不改 docs 表结构）：
 *   doc_folder       id=folder_id，scope=所有者；data {name, parent_id, owner_id}。文件夹是个人的（「我的空间」）。
 *   doc_folder_item  id=`${user}:${doc}`，scope=用户；data {doc_id, folder_id}。文档在某人空间里放在哪个文件夹，没有记录 = 根目录。
 *   doc_star         id=`${user}:${doc}`，scope=用户；data {doc_id}。
 *   doc_trash        id=doc_id；data {deleted_at, deleted_by}。文档进回收站，对所有人生效。
 *
 * 回收站里的文档在 docAccess() 里一律视为无权访问（评论、协同、搜索、最近访问都会自动挡住），
 * 只有回收站列表、恢复、彻底删除用 rawDocAccess() 判断 can_delete。30 天后自动彻底删除（列回收站时清理）。
 */
import type { Ctx } from './context.js';
import { newId } from './context.js';
import { nowIso, type EntityRecord } from './repo.js';

export const TRASH_KEEP_DAYS = 30;
const FOLDER = 'doc_folder';
const ITEM = 'doc_folder_item';
const STAR = 'doc_star';
const TRASH = 'doc_trash';
const MAX_NAME = 100;

export interface Folder { folder_id: string; name: string; parent_id: string | null; owner_id: string; created_at: string; updated_at: string }
export class LibraryError extends Error { constructor(public status: number, message: string, public code: string) { super(message); } }

const folderOf = (r: EntityRecord): Folder => ({
  folder_id: r.id, name: String(r.data.name), parent_id: (r.data.parent_id as string | null) ?? null,
  owner_id: String(r.data.owner_id), created_at: r.created_at, updated_at: r.updated_at,
});

export class DocLibrary {
  constructor(private ctx: Ctx) {}
  private get repo() { return this.ctx.repo; }

  private async put(kind: string, id: string, scope: string, data: Record<string, unknown>) {
    const now = nowIso();
    for (let i = 0; i < 5; i++) {
      const cur = await this.repo.getEntity(kind, id);
      const ok = await this.repo.saveEntity({ kind, id, scope, data, version: cur?.version ?? 0, created_at: cur?.created_at ?? now, updated_at: now }, cur?.version ?? 0);
      if (ok) return;
    }
    throw new LibraryError(409, '数据已被修改，请重试', 'CONFLICT');
  }

  // ------------------------------------------------ 回收站
  async trashInfo(docId: string): Promise<{ deleted_at: string; deleted_by: string } | undefined> {
    const r = await this.repo.getEntity(TRASH, docId);
    return r ? { deleted_at: String(r.data.deleted_at), deleted_by: String(r.data.deleted_by) } : undefined;
  }
  async trashMap(): Promise<Map<string, { deleted_at: string; deleted_by: string }>> {
    return new Map((await this.repo.listEntities(TRASH)).map((r) => [r.id, { deleted_at: String(r.data.deleted_at), deleted_by: String(r.data.deleted_by) }]));
  }
  async trash(docId: string, by: string) {
    if (await this.repo.getEntity(TRASH, docId)) return;
    await this.put(TRASH, docId, 'global', { deleted_at: nowIso(), deleted_by: by });
  }
  async restore(docId: string) {
    await this.repo.deleteEntity(TRASH, docId);
  }
  /** 彻底删除后清理本模块的记录（收藏、文件夹位置、回收站标记）。 */
  async forget(docId: string) {
    await this.repo.deleteEntity(TRASH, docId);
    for (const kind of [ITEM, STAR]) {
      for (const r of await this.repo.listEntities(kind)) if (r.data.doc_id === docId) await this.repo.deleteEntity(kind, r.id);
    }
  }

  // ------------------------------------------------ 收藏
  async starredMap(uid: string): Promise<Map<string, string>> {
    return new Map((await this.repo.listEntities(STAR, uid)).map((r) => [String(r.data.doc_id), r.created_at]));
  }
  async star(uid: string, docId: string, on: boolean) {
    const id = `${uid}:${docId}`;
    if (!on) { await this.repo.deleteEntity(STAR, id); return; }
    if (!(await this.repo.getEntity(STAR, id))) await this.put(STAR, id, uid, { doc_id: docId });
  }

  // ------------------------------------------------ 文件夹位置
  async placementMap(uid: string): Promise<Map<string, string>> {
    return new Map((await this.repo.listEntities(ITEM, uid)).map((r) => [String(r.data.doc_id), String(r.data.folder_id)]));
  }
  async folderOfDoc(uid: string, docId: string): Promise<string | null> {
    const r = await this.repo.getEntity(ITEM, `${uid}:${docId}`);
    return r ? String(r.data.folder_id) : null;
  }
  /** folderId=null 放回根目录。文件夹必须是 uid 自己的。 */
  async place(uid: string, docId: string, folderId: string | null) {
    const id = `${uid}:${docId}`;
    if (folderId === null) { await this.repo.deleteEntity(ITEM, id); return; }
    await this.ownFolder(uid, folderId);
    await this.put(ITEM, id, uid, { doc_id: docId, folder_id: folderId });
  }

  // ------------------------------------------------ 文件夹
  async folders(uid: string): Promise<Folder[]> {
    return (await this.repo.listEntities(FOLDER, uid)).map(folderOf);
  }
  async ownFolder(uid: string, folderId: string): Promise<Folder> {
    const r = await this.repo.getEntity(FOLDER, folderId);
    if (!r || r.data.owner_id !== uid) throw new LibraryError(404, '文件夹不存在', 'NOT_FOUND');
    return folderOf(r);
  }
  private name(v: unknown): string {
    if (typeof v !== 'string' || !v.trim() || v.trim().length > MAX_NAME) throw new LibraryError(422, `文件夹名称不能为空，且不超过 ${MAX_NAME} 字`, 'VALIDATION_FAILED');
    return v.trim();
  }
  private async checkName(uid: string, parent: string | null, name: string, self?: string) {
    const dup = (await this.folders(uid)).some((f) => f.folder_id !== self && f.parent_id === parent && f.name.toLowerCase() === name.toLowerCase());
    if (dup) throw new LibraryError(409, '同一位置已有同名文件夹', 'CONFLICT');
  }
  private async parent(uid: string, v: unknown): Promise<string | null> {
    if (v === null || v === undefined) return null;
    if (typeof v !== 'string') throw new LibraryError(422, 'parent_id 必须是文件夹 ID 或 null', 'VALIDATION_FAILED');
    await this.ownFolder(uid, v);
    return v;
  }
  async createFolder(uid: string, body: Record<string, unknown>): Promise<Folder> {
    const name = this.name(body.name);
    const parent_id = await this.parent(uid, body.parent_id);
    await this.checkName(uid, parent_id, name);
    const id = newId('fld');
    await this.put(FOLDER, id, uid, { name, parent_id, owner_id: uid });
    return this.ownFolder(uid, id);
  }
  /** 自己及所有下级文件夹 ID。 */
  async subtree(uid: string, folderId: string): Promise<Set<string>> {
    const all = await this.folders(uid);
    const out = new Set([folderId]);
    let n = 0;
    while (n !== out.size) { n = out.size; for (const f of all) if (f.parent_id && out.has(f.parent_id)) out.add(f.folder_id); }
    return out;
  }
  async updateFolder(uid: string, folderId: string, body: Record<string, unknown>): Promise<Folder> {
    const f = await this.ownFolder(uid, folderId);
    const name = body.name === undefined ? f.name : this.name(body.name);
    const parent_id = body.parent_id === undefined ? f.parent_id : await this.parent(uid, body.parent_id);
    if (parent_id && (await this.subtree(uid, folderId)).has(parent_id)) throw new LibraryError(400, '不能把文件夹移动到自己或下级文件夹中', 'BAD_REQUEST');
    await this.checkName(uid, parent_id, name, folderId);
    await this.put(FOLDER, folderId, uid, { name, parent_id, owner_id: uid });
    return this.ownFolder(uid, folderId);
  }
  /** 删除文件夹（含下级），返回里面的文档 ID（调用方负责把能删的移进回收站）。 */
  async deleteFolder(uid: string, folderId: string): Promise<string[]> {
    await this.ownFolder(uid, folderId);
    const ids = await this.subtree(uid, folderId);
    const docs: string[] = [];
    for (const r of await this.repo.listEntities(ITEM, uid)) {
      if (ids.has(String(r.data.folder_id))) { docs.push(String(r.data.doc_id)); await this.repo.deleteEntity(ITEM, r.id); }
    }
    for (const id of ids) await this.repo.deleteEntity(FOLDER, id);
    return docs;
  }
}
