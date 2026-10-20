/**
 * 知识库权限（R-WK-01 / 03）。只依赖仓库层，doc-access.ts 和 routes-wiki.ts 都用它（避免循环引用）。
 *
 * 空间：实体 wiki_space（id = space_id）；授权存资源授权表 resource_type = 'wiki'：
 *   visibility  all = 「所有人可阅读」（前端叫 org），members = 「仅成员」
 *   members     角色存 manager / editor / viewer，对外叫 admin / editor / viewer
 * 页面：实体 wiki_node（scope = space_id）；页面对应的云文档记在 wiki_doc（id = doc_id）。
 * 页面权限继承空间：admin → manager，editor → editor，viewer → viewer；文档自己的协作者不生效，链接分享仍生效。
 */
import type { Ctx } from './context.js';
import type { EntityRecord, ResourceGrant } from './repo.js';
import { resourceRole, type ResourceRole } from './resource-access.js';

export type WikiRole = 'admin' | 'editor' | 'viewer';
export const SPACE = 'wiki_space';
export const NODE = 'wiki_node';
export const WIKI_DOC = 'wiki_doc';

const rank: Record<WikiRole, number> = { viewer: 1, editor: 2, admin: 3 };
export const toResourceRole = (r: WikiRole): ResourceRole => (r === 'admin' ? 'manager' : r);
export const fromResourceRole = (r: ResourceRole): WikiRole => (r === 'manager' ? 'admin' : r === 'commenter' ? 'viewer' : r);
export const atLeast = (r: WikiRole | null, need: WikiRole) => !!r && rank[r] >= rank[need];

export async function spaceGrant(ctx: Ctx, space: EntityRecord): Promise<ResourceGrant> {
  return (await ctx.repo.getResourceGrant('wiki', space.id)) ?? {
    resource_type: 'wiki', resource_id: space.id, owner_id: String(space.data.created_by),
    visibility: 'all', members: [], version: 0,
  };
}

export async function wikiRole(ctx: Ctx, spaceId: string, userId: string, space?: EntityRecord, grant?: ResourceGrant): Promise<WikiRole | null> {
  const s = space ?? (await ctx.repo.getEntity(SPACE, spaceId));
  if (!s) return null;
  const g = grant ?? (await spaceGrant(ctx, s));
  // 成员角色单独算（visibility 按 members），「所有人可阅读」再兜底 viewer
  const r = await resourceRole(ctx.repo, userId, { ...g, visibility: 'members' });
  let role: WikiRole | null = r ? fromResourceRole(r) : null;
  if (g.visibility === 'all' && !role) {
    const u = await ctx.repo.getUser(userId);
    if (u && !u.disabled && u.role !== 'bot') role = 'viewer';
  }
  return role;
}

export async function wikiPageOf(ctx: Ctx, docId: string): Promise<{ space_id: string; node_id: string } | undefined> {
  const r = await ctx.repo.getEntity(WIKI_DOC, docId);
  return r ? { space_id: String(r.data.space_id), node_id: String(r.data.node_id) } : undefined;
}

export { rank as wikiRank };
