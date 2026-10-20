/**
 * 任务（一期第 11 节）+ 二期迭代 3 任务扩展：
 *   R-TK-01 子任务、R-TK-02 关注人、R-TK-03 评论和动态、R-TK-04 任务清单与分组、R-TK-05 权限。
 * 存储说明见 task-access.ts。
 */

import { viaBotFor } from './agent-context.js';
import { fail, invalid, newId, type AuthedUser, type Ctx, type FieldError } from './context.js';
import type { NotificationService } from './notifications.js';
import { nowIso, type EntityRecord, type ResourceGrant, type TaskPriority, type TaskRecord, type TaskStatus } from './repo.js';
import { validateGrant } from './resource-access.js';
import { MAX_TASK_DEPTH, TaskAccess, listPermissions, taskPermissions } from './task-access.js';

const TASK_STATUSES = new Set<TaskStatus>(['pending', 'in_progress', 'done', 'cancelled']);
const PRIORITIES = new Set<TaskPriority>(['low', 'normal', 'high', 'urgent']);
const DEFAULT_SECTIONS = ['待开始', '进行中', '已完成'];
const TRACKED = ['title', 'status', 'assignee_id', 'due_ms', 'description', 'priority'] as const;

/** 同一毫秒内的动态也能排出先后。 */
let activitySeq = 0;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** 一期兼容：没有扩展信息时的原始结构。 */
export function taskJson(t: TaskRecord) {
  const { position: _p, ...rest } = t;
  return { ...rest, parent_id: t.parent_id ?? null, follower_ids: t.follower_ids ?? [] };
}

function optStr(body: Record<string, unknown>, key: string, errors: FieldError[], max: number): string | null | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'string') {
    errors.push({ field: key, message: '必须是文本' });
    return undefined;
  }
  if (v.length > max) {
    errors.push({ field: key, message: `不能超过 ${max} 字` });
    return undefined;
  }
  return v;
}

/** 富文本 {text, mentions}。 */
function parseRich(v: unknown, field: string, errors: FieldError[], max = 5000) {
  if (v === undefined || v === null) return { text: '', mentions: [] as Array<{ user_id: string; name: string; offset: number; length: number }> };
  if (!isObj(v) || typeof v.text !== 'string') {
    errors.push({ field, message: '必须是 { text, mentions }' });
    return undefined;
  }
  if (v.text.length > max) errors.push({ field: `${field}.text`, message: `不能超过 ${max} 字` });
  const mentions: Array<{ user_id: string; name: string; offset: number; length: number }> = [];
  if (v.mentions !== undefined && v.mentions !== null) {
    if (!Array.isArray(v.mentions) || v.mentions.length > 100) errors.push({ field: `${field}.mentions`, message: '必须是数组（最多 100 项）' });
    else
      for (const [i, m] of v.mentions.entries()) {
        if (!isObj(m) || typeof m.user_id !== 'string') errors.push({ field: `${field}.mentions[${i}]`, message: '缺少 user_id' });
        else mentions.push({ user_id: m.user_id, name: String(m.name ?? ''), offset: Number(m.offset) || 0, length: Number(m.length) || 0 });
      }
  }
  return { text: v.text, mentions };
}

export function registerTaskRoutes(ctx: Ctx, notifications?: NotificationService): void {
  const { app, repo } = ctx;
  const access = (me: AuthedUser | { sub: string }) => new TaskAccess(ctx, me.sub);

  // 任务附件：能看任务的人就能下载评论里的附件
  ctx.extraFileAccess.push(async (user, file) => {
    const ta = access(user);
    for (const link of await repo.listEntities('task_file', file.file_key)) {
      const t = await ta.task(String(link.data.task_id));
      if (t && (await ta.role(t))) return true;
    }
    return false;
  });

  // ---------------- 序列化 ----------------

  const full = async (t: TaskRecord, ta: TaskAccess) => {
    ta.remember(t);
    const subs = await repo.listSubtasks(t.task_id);
    const lists = await ta.allLists();
    const refs = [];
    if (!t.parent_id) {
      for (const m of await ta.membershipsOf(t.task_id)) {
        const listId = String(m.data.list_id);
        const list = lists.get(listId);
        if (list && (await ta.listRole(listId))) refs.push({ list_id: listId, section_id: (m.data.section_id as string | null) ?? null, name: String(list.data.name ?? '') });
      }
    }
    return {
      ...taskJson(t),
      depth: await ta.depth(t),
      subtask_count: subs.length,
      subtask_done_count: subs.filter((s) => s.status === 'done').length,
      tasklists: refs,
      permissions: taskPermissions(await ta.role(t)),
    };
  };

  const page = <T>(items: T[]) => ({ items, has_more: false, page_token: null, total: items.length });

  // ---------------- 事件 / 动态 ----------------

  const emit = async (type: 'task.created' | 'task.updated' | 'task.deleted' | 'task.comment_changed', t: TaskRecord, extra: string[] = []) => {
    const ta = access({ sub: t.created_by });
    const users = new Set([...(await ta.audience(t)), ...extra]);
    ctx.publish(type, { task_id: t.task_id }, [...users], { user_only: true });
    // 子任务变化时，父任务的进度也变了
    if (t.parent_id && type !== 'task.comment_changed') {
      const parent = await repo.getTask(t.parent_id);
      if (parent) ctx.publish('task.updated', { task_id: parent.task_id }, await ta.audience(parent), { user_only: true });
    }
  };

  const emitList = async (type: 'tasklist.updated' | 'tasklist.deleted', listId: string, users?: string[]) => {
    const audience = users ?? (await access({ sub: '' }).grantUsers(listId));
    ctx.publish(type, { list_id: listId }, audience, { user_only: true });
  };

  const activity = async (taskId: string, operatorId: string, action: string, changes: Array<{ field_name: string; before: unknown; after: unknown }> = [], extra: Record<string, unknown> = {}) => {
    const now = nowIso();
    await repo.saveEntity(
      { kind: 'task_activity', id: newId('ta'), scope: taskId, data: { operator_id: operatorId, at: now, seq: ++activitySeq, action, changes, ...extra, ...(viaBotFor(operatorId) ? { via_bot: true } : {}) }, version: 0, created_at: now, updated_at: now },
      0,
    );
  };

  const notifyAssigned = (task: TaskRecord, actorId: string) => {
    if (task.assignee_id && task.assignee_id !== actorId) {
      ctx.publish('task.assigned', { task: taskJson(task), actor_id: actorId }, [task.assignee_id]);
    }
  };

  // ---------------- 校验 ----------------

  const checkTask = async (body: Record<string, unknown>, partial: boolean) => {
    const errors: FieldError[] = [];
    const patch: Partial<TaskRecord> = {};
    if (body.title !== undefined || !partial) {
      if (typeof body.title !== 'string' || !body.title.trim()) errors.push({ field: 'title', message: '不能为空' });
      else if (body.title.length > 200) errors.push({ field: 'title', message: '不能超过 200 字' });
      else patch.title = body.title.trim();
    }
    if (body.status !== undefined) {
      if (typeof body.status !== 'string' || !TASK_STATUSES.has(body.status as TaskStatus)) {
        errors.push({ field: 'status', message: '必须是以下之一：pending、in_progress、done、cancelled' });
      } else patch.status = body.status as TaskStatus;
    }
    if (body.assignee_id !== undefined) {
      if (body.assignee_id === null || body.assignee_id === '') patch.assignee_id = null;
      else if (typeof body.assignee_id !== 'string') errors.push({ field: 'assignee_id', message: '必须是 user_id' });
      else if ((await ctx.missingUsers([body.assignee_id])).length) {
        errors.push({ field: 'assignee_id', message: `用户不存在：${body.assignee_id}` });
      } else patch.assignee_id = body.assignee_id;
    }
    if (body.due_ms !== undefined) {
      if (body.due_ms === null) patch.due_ms = null;
      else if (!isNum(body.due_ms)) errors.push({ field: 'due_ms', message: '必须是毫秒时间戳' });
      else patch.due_ms = Math.floor(body.due_ms);
    }
    const description = optStr(body, 'description', errors, 10000);
    if (description !== undefined) patch.description = description;
    if (body.priority !== undefined) {
      if (typeof body.priority !== 'string' || !PRIORITIES.has(body.priority as TaskPriority)) {
        errors.push({ field: 'priority', message: '必须是以下之一：low、normal、high、urgent' });
      } else patch.priority = body.priority as TaskPriority;
    }
    if (body.source !== undefined) {
      if (body.source !== null && !isObj(body.source)) errors.push({ field: 'source', message: '必须是对象' });
      else patch.source = body.source as Record<string, unknown> | null;
    }
    return { errors, patch };
  };

  /** 读任务 + 权限；看不到 404。 */
  const loadTask = async (req: { params: unknown }, reply: Parameters<typeof fail>[0], me: AuthedUser) => {
    const ta = access(me);
    const task = await ta.task((req.params as { task_id: string }).task_id);
    const role = task ? await ta.role(task) : null;
    if (!task || !role) {
      fail(reply, 404, '任务不存在');
      return undefined;
    }
    return { task, ta, perms: taskPermissions(role) };
  };

  // ---------------- 任务 ----------------

  app.get('/api/v1/tasks', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const q = req.query as { assignee_id?: string; status?: string; created_by?: string; follower_id?: string; include_subtasks?: string };
    if (q.status && !TASK_STATUSES.has(q.status as TaskStatus)) {
      return invalid(reply, [{ field: 'status', message: '必须是以下之一：pending、in_progress、done、cancelled' }]);
    }
    const ta = access(me);
    const items = await repo.listTasks(me.sub, {
      assignee_id: q.assignee_id === 'me' ? me.sub : q.assignee_id || undefined,
      status: q.status || undefined,
      created_by: q.created_by === 'me' ? me.sub : q.created_by || undefined,
      follower_id: q.follower_id === 'me' ? me.sub : q.follower_id || undefined,
      parent: q.include_subtasks === 'true' ? undefined : 'top',
      extra_ids: await ta.taskIdsInMyLists(),
    });
    const out = [];
    const seen = new Set<string>();
    for (const t of items) {
      if (seen.has(t.task_id) || !(await ta.role(t))) continue;
      seen.add(t.task_id);
      out.push(await full(t, ta));
    }
    // include_subtasks：父任务可见时，别人建的子任务也一并带出（与筛选条件一致才返回）
    if (q.include_subtasks === 'true') {
      const queue = out.map((t) => t.task_id);
      while (queue.length) {
        for (const s of await repo.listSubtasks(queue.shift()!)) {
          queue.push(s.task_id);
          if (seen.has(s.task_id)) continue;
          seen.add(s.task_id);
          if (q.status && s.status !== q.status) continue;
          if (q.assignee_id && s.assignee_id !== (q.assignee_id === 'me' ? me.sub : q.assignee_id)) continue;
          if (q.created_by && s.created_by !== (q.created_by === 'me' ? me.sub : q.created_by)) continue;
          const fid = q.follower_id === 'me' ? me.sub : q.follower_id;
          if (fid && !(s.follower_ids ?? []).includes(fid)) continue;
          out.push(await full(s, ta));
        }
      }
    }
    return page(out);
  });

  app.post('/api/v1/tasks', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (body.title === undefined) return fail(reply, 400, '缺少 title');
    const { errors, patch } = await checkTask(body, false);
    const ta = access(me);
    // 子任务
    let parent: TaskRecord | undefined;
    if (body.parent_id !== undefined && body.parent_id !== null && body.parent_id !== '') {
      if (typeof body.parent_id !== 'string') errors.push({ field: 'parent_id', message: '必须是任务 ID' });
      else {
        parent = await ta.task(body.parent_id);
        if (!parent || !(await ta.role(parent))) return fail(reply, 404, '父任务不存在');
        if (!taskPermissions(await ta.role(parent)).can_edit) return fail(reply, 403, '没有父任务的编辑权限，不能添加子任务', { code: 'FORBIDDEN' });
        if ((await ta.depth(parent)) >= MAX_TASK_DEPTH) {
          return fail(reply, 422, `子任务最多 ${MAX_TASK_DEPTH} 层`, { code: 'TASK_DEPTH_EXCEEDED' });
        }
      }
    }
    // 一步加入清单（可选）
    let listId: string | undefined;
    let sectionId: string | null = null;
    if (body.list_id !== undefined && body.list_id !== null) {
      if (parent) errors.push({ field: 'list_id', message: '子任务跟随父任务，不能单独加入清单' });
      else if (typeof body.list_id !== 'string') errors.push({ field: 'list_id', message: '必须是清单 ID' });
      else {
        listId = body.list_id;
        const check = await checkListTarget(ta, listId, body.section_id);
        if ('error' in check) return fail(reply, check.status, check.error, check.code ? { code: check.code } : undefined);
        sectionId = check.sectionId;
      }
    }
    if (errors.length) return invalid(reply, errors);
    const now = nowIso();
    const status = patch.status ?? 'pending';
    const siblings = parent ? await repo.listSubtasks(parent.task_id) : [];
    const task: TaskRecord = {
      task_id: newId('task'),
      title: patch.title!,
      status,
      assignee_id: patch.assignee_id ?? null,
      due_ms: patch.due_ms ?? null,
      description: patch.description ?? null,
      priority: patch.priority ?? 'normal',
      source: patch.source ?? null,
      created_by: me.sub,
      created_at: now,
      updated_at: now,
      completed_at: status === 'done' ? now : null,
      parent_id: parent?.task_id ?? null,
      position: parent ? Math.max(0, ...siblings.map((s) => (s.position ?? 0) + 1)) : null,
      follower_ids: [],
    };
    await repo.saveTask(task);
    await activity(task.task_id, me.sub, 'created');
    if (parent) await activity(parent.task_id, me.sub, 'subtask_added', [], { subtask_id: task.task_id, subtask_title: task.title });
    if (listId) {
      await repo.saveEntity({ kind: 'task_in_list', id: `${task.task_id}|${listId}`, scope: listId, data: { task_id: task.task_id, list_id: listId, section_id: sectionId }, version: 0, created_at: now, updated_at: now }, 0);
      await activity(task.task_id, me.sub, 'tasklist_added', [], { list_id: listId });
    }
    notifyAssigned(task, me.sub);
    await emit('task.created', task);
    if (listId) await emitList('tasklist.updated', listId);
    return reply.code(201).send(await full(task, access(me)));
  });

  app.get('/api/v1/tasks/:task_id', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const r = await loadTask(req, reply, me);
    if (!r) return;
    return full(r.task, r.ta);
  });

  app.patch('/api/v1/tasks/:task_id', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const r = await loadTask(req, reply, me);
    if (!r) return;
    if (!r.perms.can_edit) return fail(reply, 403, '你可以查看和评论这个任务，但不能修改', { code: 'FORBIDDEN' });
    const { task } = r;
    const { errors, patch } = await checkTask((req.body ?? {}) as Record<string, unknown>, true);
    if (errors.length) return invalid(reply, errors);
    const now = nowIso();
    const next: TaskRecord = { ...task, ...patch, updated_at: now };
    if (patch.status !== undefined && patch.status !== task.status) {
      next.completed_at = patch.status === 'done' ? now : null;
    }
    const changes = TRACKED.filter((k) => patch[k] !== undefined && patch[k] !== task[k]).map((k) => ({ field_name: k, before: task[k], after: next[k] }));
    await repo.saveTask(next);
    if (changes.length) {
      const action = patch.status === 'done' && task.status !== 'done' ? 'completed' : task.status === 'done' && patch.status && patch.status !== 'done' ? 'reopened' : 'updated';
      await activity(task.task_id, me.sub, action, changes);
    }
    if (patch.assignee_id !== undefined && patch.assignee_id !== task.assignee_id) notifyAssigned(next, me.sub);
    await emit('task.updated', next, task.assignee_id ? [task.assignee_id] : []);
    return full(next, access(me));
  });

  /** 删除任务：子任务一起删除；清单关联、评论、动态一起清掉（清单本身不动）。 */
  app.delete('/api/v1/tasks/:task_id', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const r = await loadTask(req, reply, me);
    if (!r) return;
    if (!r.perms.can_delete) return fail(reply, 403, '只有创建者可以删除任务', { code: 'FORBIDDEN' });
    const audience = await r.ta.audience(r.task);
    const touchedLists = new Set<string>();
    const removeTree = async (t: TaskRecord) => {
      for (const s of await repo.listSubtasks(t.task_id)) await removeTree(s);
      for (const m of await r.ta.membershipsOf(t.task_id)) {
        touchedLists.add(String(m.data.list_id));
        await repo.deleteEntity('task_in_list', m.id);
      }
      for (const kind of ['task_comment', 'task_activity']) for (const e of await repo.listEntities(kind, t.task_id)) await repo.deleteEntity(kind, e.id);
      await repo.deleteTask(t.task_id);
    };
    await removeTree(r.task);
    ctx.publish('task.deleted', { task_id: r.task.task_id }, audience, { user_only: true });
    if (r.task.parent_id) {
      const parent = await repo.getTask(r.task.parent_id);
      if (parent) ctx.publish('task.updated', { task_id: parent.task_id }, await access(me).audience(parent), { user_only: true });
    }
    for (const l of touchedLists) await emitList('tasklist.updated', l);
    return reply.code(204).send();
  });

  // ---------------- 子任务 ----------------

  app.get('/api/v1/tasks/:task_id/subtasks', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const r = await loadTask(req, reply, me);
    if (!r) return;
    const out = [];
    for (const s of await repo.listSubtasks(r.task.task_id)) out.push(await full(s, r.ta));
    return page(out);
  });

  app.post('/api/v1/tasks/:task_id/subtasks/order', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const r = await loadTask(req, reply, me);
    if (!r) return;
    if (!r.perms.can_edit) return fail(reply, 403, '没有编辑权限，不能调整子任务顺序', { code: 'FORBIDDEN' });
    const ids = (req.body as { task_ids?: unknown } | undefined)?.task_ids;
    const subs = await repo.listSubtasks(r.task.task_id);
    if (!Array.isArray(ids) || ids.some((x) => typeof x !== 'string') || new Set(ids).size !== ids.length) {
      return invalid(reply, [{ field: 'task_ids', message: '必须是不重复的子任务 ID 列表' }]);
    }
    const known = new Set(subs.map((s) => s.task_id));
    if (ids.length !== subs.length || ids.some((x) => !known.has(x as string))) {
      return fail(reply, 409, '子任务已经变化，请刷新后再排序', { code: 'SUBTASKS_CHANGED' });
    }
    const byId = new Map(subs.map((s) => [s.task_id, s]));
    for (const [i, id] of (ids as string[]).entries()) {
      const s = byId.get(id)!;
      if (s.position !== i) await repo.saveTask({ ...s, position: i });
    }
    await emit('task.updated', r.task);
    return page(await Promise.all((await repo.listSubtasks(r.task.task_id)).map((s) => full(s, r.ta))));
  });

  // ---------------- 关注人 ----------------

  const setFollower = async (req: { params: unknown }, reply: Parameters<typeof fail>[0], me: AuthedUser, follow: boolean) => {
    const r = await loadTask(req, reply, me);
    if (!r) return;
    const { user_id } = req.params as { user_id: string };
    const uid = user_id === 'me' ? me.sub : user_id;
    const self = uid === me.sub;
    if (self ? !r.perms.can_follow : !r.perms.can_manage_followers) {
      return fail(reply, 403, self ? '没有权限关注这个任务' : '没有权限添加或移除其他关注人', { code: 'FORBIDDEN' });
    }
    if (follow) {
      const u = await repo.getUser(uid);
      if (!u || u.disabled || u.role === 'bot') return invalid(reply, [{ field: 'user_id', message: '成员不存在或不可用' }]);
    }
    const before = r.task.follower_ids ?? [];
    const after = follow ? [...new Set([...before, uid])] : before.filter((x) => x !== uid);
    if (after.length === before.length) return full(r.task, r.ta);
    if (after.length > 200) return invalid(reply, [{ field: 'user_id', message: '关注人不能超过 200 个' }]);
    const next: TaskRecord = { ...r.task, follower_ids: after, updated_at: nowIso() };
    await repo.saveTask(next);
    await activity(next.task_id, me.sub, follow ? 'follower_added' : 'follower_removed', [], { user_id: uid });
    await emit('task.updated', next, follow ? [] : [uid]);
    if (follow && !self && notifications) {
      const name = await ctx.userName(me.sub);
      await notifications.notify({ user_id: uid, type: 'task.followed', actor_id: me.sub, title: `${name} 把你加为任务「${next.title}」的关注人`, target: { type: 'task', id: next.task_id } });
    }
    return full(next, access(me));
  };

  app.post('/api/v1/tasks/:task_id/followers/:user_id', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    return setFollower(req, reply, me, true);
  });
  app.delete('/api/v1/tasks/:task_id/followers/:user_id', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    return setFollower(req, reply, me, false);
  });

  // ---------------- 评论和动态 ----------------

  const commentJson = (e: EntityRecord, me: string, canDeleteAny: boolean) => ({
    comment_id: e.id,
    task_id: e.scope,
    user_id: e.data.user_id,
    content: e.data.content,
    attachments: e.data.attachments ?? [],
    created_at: e.created_at,
    permissions: { can_delete: e.data.user_id === me || canDeleteAny },
  });

  app.get('/api/v1/tasks/:task_id/comments', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const r = await loadTask(req, reply, me);
    if (!r) return;
    return page((await repo.listEntities('task_comment', r.task.task_id)).map((e) => commentJson(e, me.sub, r.perms.can_delete)));
  });

  app.post('/api/v1/tasks/:task_id/comments', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const r = await loadTask(req, reply, me);
    if (!r) return;
    if (!r.perms.can_comment) return fail(reply, 403, '没有评论权限', { code: 'FORBIDDEN' });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const errors: FieldError[] = [];
    const content = parseRich(body.content, 'content', errors);
    const attachments: Array<{ file_key: string; name: string; size: number; mime_type: string | null }> = [];
    if (body.attachments !== undefined && body.attachments !== null) {
      if (!Array.isArray(body.attachments) || body.attachments.length > 20) errors.push({ field: 'attachments', message: '必须是数组（最多 20 个）' });
      else
        for (const [i, a] of body.attachments.entries()) {
          const f = `attachments[${i}]`;
          if (!isObj(a) || typeof a.file_key !== 'string') {
            errors.push({ field: f, message: '缺少 file_key' });
            continue;
          }
          const file = await repo.getFile(a.file_key);
          if (!file || !(await ctx.canAccessFile(me, file))) {
            errors.push({ field: `${f}.file_key`, message: '文件不存在或无权访问' });
            continue;
          }
          attachments.push({ file_key: file.file_key, name: typeof a.name === 'string' && a.name ? a.name : file.file_name, size: file.size, mime_type: typeof a.mime_type === 'string' ? a.mime_type : file.content_type });
        }
    }
    if (errors.length) return invalid(reply, errors);
    if (!content!.text.trim() && !attachments.length) return invalid(reply, [{ field: 'content', message: '文字和附件至少要有一样' }]);
    const now = nowIso();
    const id = newId('tc');
    const rec: EntityRecord = { kind: 'task_comment', id, scope: r.task.task_id, data: { user_id: me.sub, content: content!, attachments }, version: 0, created_at: now, updated_at: now };
    await repo.saveEntity(rec, 0);
    for (const a of attachments) {
      await repo.saveEntity({ kind: 'task_file', id: `${a.file_key}|${r.task.task_id}`, scope: a.file_key, data: { task_id: r.task.task_id }, version: 0, created_at: now, updated_at: now }, 0);
    }
    await activity(r.task.task_id, me.sub, 'commented', [], { comment_id: id });
    await emit('task.comment_changed', r.task);
    if (notifications) {
      const name = await ctx.userName(me.sub);
      const summary = content!.text.slice(0, 80) || `[附件] ${attachments.map((a) => a.name).join('、')}`;
      const mentioned = new Set<string>();
      for (const m of content!.mentions) {
        if (m.user_id === me.sub || mentioned.has(m.user_id)) continue;
        const t = await access({ sub: m.user_id }).role(r.task);
        if (!t) continue; // 看不到任务的人不通知（不泄露任务内容）
        mentioned.add(m.user_id);
        await notifications.notify({ user_id: m.user_id, type: 'task.mention', actor_id: me.sub, title: `${name} 在任务「${r.task.title}」中提到了你`, summary, target: { type: 'task', id: r.task.task_id, comment_id: id } });
      }
      for (const uid of new Set([r.task.created_by, r.task.assignee_id, ...(r.task.follower_ids ?? [])])) {
        if (!uid || uid === me.sub || mentioned.has(uid)) continue;
        await notifications.notify({ user_id: uid, type: 'task.comment', actor_id: me.sub, title: `${name} 评论了任务「${r.task.title}」`, summary, target: { type: 'task', id: r.task.task_id, comment_id: id } });
      }
    }
    return reply.code(201).send(commentJson(rec, me.sub, r.perms.can_delete));
  });

  app.delete('/api/v1/tasks/:task_id/comments/:comment_id', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const r = await loadTask(req, reply, me);
    if (!r) return;
    const c = await repo.getEntity('task_comment', (req.params as { comment_id: string }).comment_id);
    if (!c || c.scope !== r.task.task_id) return fail(reply, 404, '评论不存在');
    if (c.data.user_id !== me.sub && !r.perms.can_delete) return fail(reply, 403, '只能删除自己的评论', { code: 'FORBIDDEN' });
    await repo.deleteEntity('task_comment', c.id);
    await emit('task.comment_changed', r.task);
    return reply.code(204).send();
  });

  app.get('/api/v1/tasks/:task_id/activities', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const r = await loadTask(req, reply, me);
    if (!r) return;
    const items = (await repo.listEntities('task_activity', r.task.task_id))
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || Number(b.data.seq ?? 0) - Number(a.data.seq ?? 0))
      .map((e) => {
        const { seq: _s, ...data } = e.data;
        return { activity_id: e.id, ...data, changes: e.data.changes ?? [] };
      });
    return page(items);
  });

  // ---------------- 任务清单 ----------------

  type ListCheck = { error: string; status: number; code?: string } | { sectionId: string | null };

  /** 目标清单可编辑、分组属于这个清单。 */
  async function checkListTarget(ta: TaskAccess, listId: string, rawSection: unknown): Promise<ListCheck> {
    const list = (await ta.allLists()).get(listId);
    const role = list ? await ta.listRole(listId) : null;
    if (!list || !role) return { error: '清单不存在', status: 404 };
    if (!listPermissions(role).can_edit) return { error: '没有这个清单的编辑权限', status: 403, code: 'FORBIDDEN' };
    if (rawSection === undefined || rawSection === null || rawSection === '') return { sectionId: null };
    if (typeof rawSection !== 'string') return { error: 'section_id 必须是分组 ID 或 null', status: 422, code: 'VALIDATION_FAILED' };
    const s = await repo.getEntity('task_section', rawSection);
    if (!s || s.scope !== listId) return { error: '分组不存在', status: 422, code: 'VALIDATION_FAILED' };
    return { sectionId: s.id };
  }

  const listJson = async (e: EntityRecord, ta: TaskAccess) => {
    const g = await ta.grant(e.id);
    return {
      list_id: e.id,
      name: e.data.name,
      description: e.data.description ?? '',
      project_record_id: e.data.project_record_id ?? null,
      owner_id: g?.owner_id ?? e.data.created_by,
      created_by: e.data.created_by,
      created_at: e.created_at,
      updated_at: e.updated_at,
      permissions: listPermissions(await ta.listRole(e.id)),
    };
  };

  const loadList = async (req: { params: unknown }, reply: Parameters<typeof fail>[0], me: AuthedUser) => {
    const ta = access(me);
    const list = (await ta.allLists()).get((req.params as { list_id: string }).list_id);
    const role = list ? await ta.listRole(list.id) : null;
    if (!list || !role) {
      fail(reply, 404, '清单不存在');
      return undefined;
    }
    return { list, ta, perms: listPermissions(role) };
  };

  const checkListBody = (body: Record<string, unknown>, partial: boolean) => {
    const errors: FieldError[] = [];
    const out: Record<string, unknown> = {};
    if (body.name !== undefined || !partial) {
      if (typeof body.name !== 'string' || !body.name.trim()) errors.push({ field: 'name', message: '不能为空' });
      else if (body.name.trim().length > 100) errors.push({ field: 'name', message: '不能超过 100 字' });
      else out.name = body.name.trim();
    }
    const d = optStr(body, 'description', errors, 1000);
    if (d !== undefined) out.description = d ?? '';
    const p = optStr(body, 'project_record_id', errors, 100);
    if (p !== undefined) out.project_record_id = p;
    return { errors, out };
  };

  app.get('/api/v1/tasklists', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const { project_record_id } = req.query as { project_record_id?: string };
    const ta = access(me);
    const out = [];
    for (const e of (await ta.allLists()).values()) {
      if (project_record_id && e.data.project_record_id !== project_record_id) continue;
      if (await ta.listRole(e.id)) out.push(await listJson(e, ta));
    }
    return page(out);
  });

  app.post('/api/v1/tasklists', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const { errors, out } = checkListBody((req.body ?? {}) as Record<string, unknown>, false);
    if (errors.length) return invalid(reply, errors);
    const now = nowIso();
    const id = newId('tl');
    const rec: EntityRecord = { kind: 'tasklist', id, scope: '', data: { name: out.name, description: out.description ?? '', project_record_id: out.project_record_id ?? null, created_by: me.sub }, version: 0, created_at: now, updated_at: now };
    await repo.saveEntity(rec, 0);
    await repo.saveResourceGrant({ resource_type: 'tasklist', resource_id: id, owner_id: me.sub, visibility: 'members', members: [], version: 0 }, 0);
    for (const [i, name] of DEFAULT_SECTIONS.entries()) {
      await repo.saveEntity({ kind: 'task_section', id: newId('sec'), scope: id, data: { name, order: i }, version: 0, created_at: now, updated_at: now }, 0);
    }
    return reply.code(201).send(await listJson((await repo.getEntity('tasklist', id))!, access(me)));
  });

  app.patch('/api/v1/tasklists/:list_id', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const r = await loadList(req, reply, me);
    if (!r) return;
    if (!r.perms.can_manage) return fail(reply, 403, '只有清单管理者可以修改清单', { code: 'FORBIDDEN' });
    const { errors, out } = checkListBody((req.body ?? {}) as Record<string, unknown>, true);
    if (errors.length) return invalid(reply, errors);
    const next = { ...r.list, data: { ...r.list.data, ...out }, updated_at: nowIso() };
    if (!(await repo.saveEntity(next, r.list.version))) return fail(reply, 409, '清单已被修改，请刷新后重试', { code: 'VERSION_CONFLICT' });
    await emitList('tasklist.updated', r.list.id);
    return listJson((await repo.getEntity('tasklist', r.list.id))!, access(me));
  });

  /** 删除清单：只解除任务关联，不删任务。 */
  app.delete('/api/v1/tasklists/:list_id', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const r = await loadList(req, reply, me);
    if (!r) return;
    if (!r.perms.can_delete) return fail(reply, 403, '只有清单管理者可以删除清单', { code: 'FORBIDDEN' });
    const users = await r.ta.grantUsers(r.list.id);
    const affected: string[] = [];
    for (const m of await repo.listEntities('task_in_list', r.list.id)) {
      affected.push(String(m.data.task_id));
      await repo.deleteEntity('task_in_list', m.id);
    }
    for (const s of await repo.listEntities('task_section', r.list.id)) await repo.deleteEntity('task_section', s.id);
    await repo.deleteEntity('tasklist', r.list.id);
    await emitList('tasklist.deleted', r.list.id, users);
    for (const id of affected) {
      const t = await repo.getTask(id);
      if (t) ctx.publish('task.updated', { task_id: id }, [...new Set([...(await access(me).audience(t)), ...users])], { user_only: true });
    }
    return reply.code(204).send();
  });

  app.get('/api/v1/tasklists/:list_id/members', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const r = await loadList(req, reply, me);
    if (!r) return;
    const g = (await r.ta.grant(r.list.id))!;
    return { owner_id: g.owner_id, members: g.members, version: g.version };
  });

  app.put('/api/v1/tasklists/:list_id/members', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const r = await loadList(req, reply, me);
    if (!r) return;
    if (!r.perms.can_manage) return fail(reply, 403, '只有清单管理者可以管理成员', { code: 'FORBIDDEN' });
    const body = (req.body ?? {}) as { members?: unknown; version?: unknown };
    const g = (await r.ta.grant(r.list.id))!;
    if (body.version !== undefined && body.version !== g.version) return fail(reply, 409, '成员已被别人修改，请刷新后重试', { code: 'VERSION_CONFLICT' });
    const next: ResourceGrant = { ...g, members: body.members as ResourceGrant['members'] };
    const errors = await validateGrant(repo, next);
    if (errors.length) return invalid(reply, errors);
    const before = await r.ta.grantUsers(r.list.id);
    if (!(await repo.saveResourceGrant(next, g.version))) return fail(reply, 409, '成员已被别人修改，请刷新后重试', { code: 'VERSION_CONFLICT' });
    const after = await access(me).grantUsers(r.list.id);
    await emitList('tasklist.updated', r.list.id, [...new Set([...before, ...after])]);
    const saved = (await repo.getResourceGrant('tasklist', r.list.id))!;
    return { owner_id: saved.owner_id, members: saved.members, version: saved.version };
  });

  // ---------------- 分组 ----------------

  const sectionJson = (e: EntityRecord) => ({ section_id: e.id, list_id: e.scope, name: e.data.name, order: Number(e.data.order ?? 0) });
  const sectionsOf = async (listId: string) =>
    (await repo.listEntities('task_section', listId)).sort((a, b) => Number(a.data.order ?? 0) - Number(b.data.order ?? 0) || a.created_at.localeCompare(b.created_at));

  const checkSectionName = async (listId: string, raw: unknown, exceptId?: string): Promise<{ name: string } | { status: number; message: string; code?: string; field?: string }> => {
    if (typeof raw !== 'string' || !raw.trim()) return { status: 422, message: '不能为空', field: 'name' };
    const name = raw.trim();
    if (name.length > 50) return { status: 422, message: '不能超过 50 字', field: 'name' };
    const dup = (await sectionsOf(listId)).some((s) => s.id !== exceptId && String(s.data.name).toLowerCase() === name.toLowerCase());
    if (dup) return { status: 409, message: `分组「${name}」已存在`, code: 'SECTION_NAME_EXISTS' };
    return { name };
  };

  app.get('/api/v1/tasklists/:list_id/sections', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const r = await loadList(req, reply, me);
    if (!r) return;
    return page((await sectionsOf(r.list.id)).map(sectionJson));
  });

  app.post('/api/v1/tasklists/:list_id/sections', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const r = await loadList(req, reply, me);
    if (!r) return;
    if (!r.perms.can_edit) return fail(reply, 403, '没有这个清单的编辑权限', { code: 'FORBIDDEN' });
    const c = await checkSectionName(r.list.id, (req.body as { name?: unknown } | undefined)?.name);
    if (!('name' in c)) return c.field ? invalid(reply, [{ field: c.field, message: c.message }]) : fail(reply, c.status, c.message, { code: c.code });
    const now = nowIso();
    const order = Math.max(-1, ...(await sectionsOf(r.list.id)).map((s) => Number(s.data.order ?? 0))) + 1;
    const rec: EntityRecord = { kind: 'task_section', id: newId('sec'), scope: r.list.id, data: { name: c.name, order }, version: 0, created_at: now, updated_at: now };
    await repo.saveEntity(rec, 0);
    await emitList('tasklist.updated', r.list.id);
    return reply.code(201).send(sectionJson(rec));
  });

  app.patch('/api/v1/tasklists/:list_id/sections/:section_id', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const r = await loadList(req, reply, me);
    if (!r) return;
    if (!r.perms.can_edit) return fail(reply, 403, '没有这个清单的编辑权限', { code: 'FORBIDDEN' });
    const s = await repo.getEntity('task_section', (req.params as { section_id: string }).section_id);
    if (!s || s.scope !== r.list.id) return fail(reply, 404, '分组不存在');
    const c = await checkSectionName(r.list.id, (req.body as { name?: unknown } | undefined)?.name, s.id);
    if (!('name' in c)) return c.field ? invalid(reply, [{ field: c.field, message: c.message }]) : fail(reply, c.status, c.message, { code: c.code });
    const next = { ...s, data: { ...s.data, name: c.name }, updated_at: nowIso() };
    if (!(await repo.saveEntity(next, s.version))) return fail(reply, 409, '分组已被修改，请刷新后重试', { code: 'VERSION_CONFLICT' });
    await emitList('tasklist.updated', r.list.id);
    return sectionJson(next);
  });

  /** 删除分组：里面的任务移到「未分组」（section_id = null），不删任务。 */
  app.delete('/api/v1/tasklists/:list_id/sections/:section_id', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const r = await loadList(req, reply, me);
    if (!r) return;
    if (!r.perms.can_edit) return fail(reply, 403, '没有这个清单的编辑权限', { code: 'FORBIDDEN' });
    const s = await repo.getEntity('task_section', (req.params as { section_id: string }).section_id);
    if (!s || s.scope !== r.list.id) return fail(reply, 404, '分组不存在');
    for (const m of await repo.listEntities('task_in_list', r.list.id)) {
      if (m.data.section_id === s.id) await repo.saveEntity({ ...m, data: { ...m.data, section_id: null }, updated_at: nowIso() }, m.version);
    }
    await repo.deleteEntity('task_section', s.id);
    await emitList('tasklist.updated', r.list.id);
    return reply.code(204).send();
  });

  app.get('/api/v1/tasklists/:list_id/tasks', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const r = await loadList(req, reply, me);
    if (!r) return;
    const out = [];
    for (const m of await repo.listEntities('task_in_list', r.list.id)) {
      const t = await r.ta.task(String(m.data.task_id));
      if (t) out.push(await full(t, r.ta));
    }
    return page(out);
  });

  /** 加入清单，或在同一清单的分组间移动（section_id: null = 未分组）。不改任务状态。 */
  app.post('/api/v1/tasks/:task_id/tasklists', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const r = await loadTask(req, reply, me);
    if (!r) return;
    const body = (req.body ?? {}) as { list_id?: unknown; section_id?: unknown };
    if (typeof body.list_id !== 'string') return invalid(reply, [{ field: 'list_id', message: '必须是清单 ID' }]);
    if (r.task.parent_id) return invalid(reply, [{ field: 'task_id', message: '子任务跟随父任务，不能单独加入清单' }]);
    const check = await checkListTarget(r.ta, body.list_id, body.section_id);
    if ('error' in check) {
      return check.status === 422 ? invalid(reply, [{ field: 'section_id', message: check.error }]) : fail(reply, check.status, check.error, check.code ? { code: check.code } : undefined);
    }
    const id = `${r.task.task_id}|${body.list_id}`;
    const existing = await repo.getEntity('task_in_list', id);
    // 新加入清单会让清单成员看到这个任务：需要任务的编辑权限；已在清单里移动分组只需清单编辑权限
    if (!existing && !r.perms.can_edit) return fail(reply, 403, '没有这个任务的编辑权限，不能把它加入清单', { code: 'FORBIDDEN' });
    const now = nowIso();
    if (existing) {
      if (existing.data.section_id !== check.sectionId) {
        await repo.saveEntity({ ...existing, data: { ...existing.data, section_id: check.sectionId }, updated_at: now }, existing.version);
      }
    } else {
      await repo.saveEntity({ kind: 'task_in_list', id, scope: body.list_id, data: { task_id: r.task.task_id, list_id: body.list_id, section_id: check.sectionId }, version: 0, created_at: now, updated_at: now }, 0);
      await activity(r.task.task_id, me.sub, 'tasklist_added', [], { list_id: body.list_id });
    }
    await emit('task.updated', r.task);
    await emitList('tasklist.updated', body.list_id);
    return full(r.task, access(me));
  });

  app.delete('/api/v1/tasks/:task_id/tasklists/:list_id', async (req, reply) => {
    const me = await ctx.requireUser(req, reply);
    if (!me) return;
    const ta = access(me);
    const { task_id, list_id } = req.params as { task_id: string; list_id: string };
    const list = (await ta.allLists()).get(list_id);
    const role = list ? await ta.listRole(list_id) : null;
    if (!list || !role) return fail(reply, 404, '清单不存在');
    if (!listPermissions(role).can_edit) return fail(reply, 403, '没有这个清单的编辑权限', { code: 'FORBIDDEN' });
    const m = await repo.getEntity('task_in_list', `${task_id}|${list_id}`);
    if (!m) return fail(reply, 404, '任务不在这个清单里');
    const task = await repo.getTask(task_id);
    const audience = task ? await ta.audience(task) : [];
    await repo.deleteEntity('task_in_list', m.id);
    if (task) {
      await activity(task_id, me.sub, 'tasklist_removed', [], { list_id });
      ctx.publish('task.updated', { task_id }, audience, { user_only: true });
    }
    await emitList('tasklist.updated', list_id);
    return reply.code(204).send();
  });
}
