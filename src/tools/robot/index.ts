/**
 * Temi 结构化工具（AGENT_PLAN M4 §3.1）：把动作直接交给模型，不再「先写中文指令再正则解析」。
 *
 *   temi_say / temi_ask / temi_goto / temi_move / temi_follow / temi_stop
 *   temi_look / temi_status / temi_locations / temi_task（送话、找人、带参观）
 *
 * 风险：移动类是 physical（先确认，可选「本次对话都允许」）；temi_stop 永远不拦；
 * 安全守卫（电量 / 单控制者锁 / 白名单 / 夜间）在控制器里，确认之后仍会检查。
 */

import { z } from 'zod';
import type { CosClient } from '../../cos-sdk/client.js';
import type { RobotController } from '../../robot/controller.js';
import type { GuardActor } from '../../robot/safety.js';
import type { AgentRuntime, ToolCallContext, ToolPolicy, ToolRisk } from '../../runtime/types.js';
import { zodToJsonSchema } from '../../runtime/zod-tool.js';
import { botSend, resolvePeople } from '../cos/tasks.js';
import type { Call } from '../cos/define.js';

export interface RobotToolsOptions {
  controller: RobotController;
  /** 平台客户端：找人、发私信、写地点表。没有时这些功能不可用。 */
  cos?: CosClient;
  /** 看图：把照片交给视觉模型描述。没有时只返回「有几个人」。 */
  describeImage?: (imageBase64: string, question: string) => Promise<string>;
}

type Result = { ok: boolean; [k: string]: unknown };

const actorOf = (ctx: ToolCallContext): GuardActor => ({ userId: ctx.actor?.userId, name: ctx.actor?.name, sessionId: ctx.sessionId });

const callFor = (client: CosClient, ctx: ToolCallContext): Call => (method, path, req = {}) =>
  client.request(method, path, { ...req, signal: req.signal ?? ctx.signal, actor: { userId: ctx.actor?.userId, sessionId: ctx.sessionId, toolCallId: ctx.toolCallId, confirmCardId: ctx.confirmation?.cardId } });

interface ToolDef<S extends z.ZodTypeAny> {
  name: string;
  description: string;
  schema: S;
  risk: (i: z.infer<S>) => ToolRisk;
  needsConfirm?: (i: z.infer<S>, risk: ToolRisk) => boolean;
  preview?: (i: z.infer<S>) => Promise<string | undefined>;
  label: (i: z.infer<S>) => string;
  run: (i: z.infer<S>, ctx: ToolCallContext) => Promise<Result>;
}

function reg<S extends z.ZodTypeAny>(runtime: AgentRuntime, def: ToolDef<S>) {
  const parse = (raw: unknown) => def.schema.safeParse(raw ?? {});
  const policy: ToolPolicy = {
    risk: (raw) => {
      const p = parse(raw);
      return p.success ? def.risk(p.data) : 'read';
    },
    needsConfirm: (raw, risk) => {
      const p = parse(raw);
      if (!p.success) return false;
      return def.needsConfirm ? def.needsConfirm(p.data, risk) : risk === 'physical' || risk === 'destructive';
    },
    preview: def.preview
      ? async (raw) => {
          const p = parse(raw);
          return p.success ? def.preview!(p.data) : undefined;
        }
      : undefined,
    label: (raw) => {
      const p = parse(raw);
      return p.success ? def.label(p.data) : def.name;
    },
  };
  runtime.registerTool(
    def.name,
    zodToJsonSchema(def.schema),
    async (raw, ctx) => {
      const p = parse(raw);
      if (!p.success) return { ok: false, error: `参数不对：${p.error.issues.map((x) => `${x.path.join('.') || '(根)'} ${x.message}`).join('；')}` };
      const risk = def.risk(p.data);
      const needs = def.needsConfirm ? def.needsConfirm(p.data, risk) : risk === 'physical' || risk === 'destructive';
      // 兜底：移动 / 删除没经过确认（例如自动化里直接调用）一律不执行
      if (needs && !ctx.confirmation) return { ok: false, need_confirmation: true, error: '这个动作会让机器人移动或删除数据，需要同学在确认卡片上点「确认」后才能执行。' };
      try {
        return await def.run(p.data, ctx);
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    { description: def.description, policy },
  );
}

const MOVE_NOTE = '机器人会在实验室里移动，请确认路线上没有障碍、周围的人知道。';

export const ROBOT_TOOL_NAMES = [
  'temi_say', 'temi_ask', 'temi_goto', 'temi_move', 'temi_follow', 'temi_stop',
  'temi_look', 'temi_status', 'temi_locations', 'temi_task',
] as const;

export function registerRobotTools(runtime: AgentRuntime, opts: RobotToolsOptions): void {
  const { controller: rc, cos } = opts;

  // ------------------------------------------------------------ 说话 / 提问
  reg(runtime, {
    name: 'temi_say',
    description: '让 Temi 机器人用语音播报一段话（不移动）。',
    schema: z.object({ text: z.string().min(1).max(500).describe('要说的话，口语化、简短') }),
    risk: () => 'write',
    label: () => 'Temi 播报',
    async run(i, ctx) {
      const r = await rc.sidecar.say(i.text);
      rc.log({ kind: 'say', text: `播报：${i.text.slice(0, 60)}`, actor_id: ctx.actor?.userId, ok: r.ok });
      return r.ok ? { ok: true, summary: 'Temi 已播报', mock: rc.sidecar.mock } : { ok: false, error: r.error };
    },
  });

  reg(runtime, {
    name: 'temi_ask',
    description: '让 Temi 当面问一句话并听回答（最多等约 45 秒），返回识别到的回答；没人回答时 reply 为 null。',
    schema: z.object({ question: z.string().min(1).max(200) }),
    risk: () => 'write',
    label: () => 'Temi 提问',
    async run(i, ctx) {
      const r = await rc.sidecar.ask(i.question);
      rc.log({ kind: 'ask', text: `提问：${i.question.slice(0, 60)}`, actor_id: ctx.actor?.userId, ok: r.ok });
      return r.ok ? { ok: true, reply: r.data?.reply ?? null } : { ok: false, error: r.error };
    },
  });

  // ------------------------------------------------------------ 移动
  reg(runtime, {
    name: 'temi_goto',
    description:
      '让 Temi 前往地点表里登记过的地点（不确定名字时先用 temi_locations 查）。wait=true 等到达再返回；' +
      'wait=false 立即返回 action_id，之后用 temi_status 查进度。系统会先发确认卡片，并检查电量、是否有人在用、夜间禁行。',
    schema: z.object({
      location: z.string().min(1).describe('地点名或别名，如「入口」「302 会议室」'),
      wait: z.boolean().default(true),
    }),
    risk: () => 'physical',
    label: (i) => `让 Temi 前往「${i.location}」`,
    preview: async (i) => {
      const loc = await rc.locations.resolve(i.location);
      return loc ? `让 Temi 机器人前往「${loc.label}」。${MOVE_NOTE}` : `让 Temi 前往「${i.location}」（地点表里没找到，确认后也不会移动）。`;
    },
    async run(i, ctx) {
      const r = await rc.goto(actorOf(ctx), i.location, { wait: i.wait });
      if (!r.ok) return { ok: false, code: r.code, error: r.error, action_id: r.action_id };
      return { ok: true, action_id: r.action_id, location: r.label, arrived: r.arrived, state: r.state, summary: r.arrived ? `已到达「${r.label}」` : `正在前往「${r.label}」` };
    },
  });

  reg(runtime, {
    name: 'temi_move',
    description: '原地转身或抬 / 低头（不离开原地）。turn_deg 正数向左转、负数向右转；tilt_deg 范围 -25～55。',
    schema: z.object({
      turn_deg: z.number().min(-360).max(360).optional(),
      tilt_deg: z.number().min(-25).max(55).optional(),
    }).refine((v) => v.turn_deg !== undefined || v.tilt_deg !== undefined, '需要 turn_deg 或 tilt_deg'),
    // 只抬头低头不会走动，不用确认
    risk: (i) => (i.turn_deg !== undefined ? 'physical' : 'write'),
    label: (i) => (i.turn_deg !== undefined ? `Temi 转身 ${i.turn_deg}°` : `Temi 抬头 ${i.tilt_deg}°`),
    preview: async (i) => `让 Temi 原地转身 ${i.turn_deg}°。`,
    async run(i, ctx) {
      const a = actorOf(ctx);
      if (i.turn_deg !== undefined) {
        const r = await rc.localMove(a, 'turn', i.turn_deg);
        if (!r.ok) return { ok: false, code: r.code, error: r.error };
      }
      if (i.tilt_deg !== undefined) {
        const r = await rc.localMove(a, 'tilt', i.tilt_deg);
        if (!r.ok) return { ok: false, code: r.code, error: r.error };
      }
      return { ok: true, summary: '已完成' };
    },
  });

  reg(runtime, {
    name: 'temi_follow',
    description: '让 Temi 跟着面前的人走（on=true），或停止跟随（on=false）。',
    schema: z.object({ on: z.boolean() }),
    risk: (i) => (i.on ? 'physical' : 'write'),
    label: (i) => (i.on ? 'Temi 跟随' : 'Temi 停止跟随'),
    preview: async () => `让 Temi 跟着面前的人走。${MOVE_NOTE}`,
    async run(i, ctx) {
      const r = await rc.localMove(actorOf(ctx), i.on ? 'follow' : 'unfollow');
      return r.ok ? { ok: true, summary: i.on ? '开始跟随' : '已停止跟随' } : { ok: false, code: r.code, error: r.error };
    },
  });

  reg(runtime, {
    name: 'temi_stop',
    description: '急停：立即停止 Temi 的一切动作。任何人任何时候都能用，不需要确认。同学说「停下」「别动」时马上调用。',
    schema: z.object({}),
    risk: () => 'physical',
    needsConfirm: () => false,
    label: () => 'Temi 急停',
    async run(_i, ctx) {
      const r = await rc.stop({ userId: ctx.actor?.userId, name: ctx.actor?.name });
      return r.ok ? { ok: true, summary: 'Temi 已停下' } : { ok: false, error: `${r.error ?? '急停指令没有送达'}。请同学直接按机器人屏幕上的停止键` };
    },
  });

  // ------------------------------------------------------------ 感知
  reg(runtime, {
    name: 'temi_look',
    description: '让 Temi 用摄像头看一眼面前：返回有没有人、几个人；配置了视觉模型时还会按 question 描述画面。只看不动。',
    schema: z.object({ question: z.string().max(200).optional().describe('想知道什么，如「桌上有没有人」') }),
    risk: () => 'read',
    label: () => 'Temi 看一眼',
    async run(i, ctx) {
      const r = await rc.sidecar.photo(i.question);
      rc.log({ kind: 'look', text: '拍照查看', actor_id: ctx.actor?.userId, ok: r.ok });
      if (!r.ok || !r.data) return { ok: false, error: r.error };
      const d = r.data;
      let description: string | undefined;
      if (d.image_base64 && opts.describeImage) {
        description = await opts.describeImage(d.image_base64, i.question ?? '描述画面里的人和环境').catch(() => undefined);
      }
      if (!d.captured) {
        const p = await rc.sidecar.detectPerson(3_000);
        return { ok: true, captured: false, person_present: p.ok ? p.data?.present : null, note: d.notes ?? '机器人这边还拍不了照片，只做了人体检测' };
      }
      return { ok: true, captured: true, people_present: d.people_present ?? null, availability: d.availability_hint, description: description ?? d.notes ?? undefined, mock: rc.sidecar.mock };
    },
  });

  reg(runtime, {
    name: 'temi_status',
    description: '查 Temi 的状态：是否在线、电量、在哪、正在做什么、谁在使用。传 action_id 可查某次导航的进度。',
    schema: z.object({ action_id: z.string().optional() }),
    risk: () => 'read',
    label: () => '查看 Temi 状态',
    async run(i) {
      const snap = await rc.snapshot();
      const action = i.action_id ? rc.getAction(i.action_id) : undefined;
      if (i.action_id && !action) return { ok: false, error: `找不到动作 ${i.action_id}（可能太久以前了）` };
      const h = snap.controller;
      return {
        ok: true,
        online: snap.status?.online ?? false,
        mock: rc.sidecar.mock,
        battery: snap.status?.battery ?? null,
        charging: snap.status?.charging ?? false,
        location: snap.status?.location ?? null,
        current_action: snap.current_action ? `正在前往「${snap.current_action.label}」` : null,
        controller: h ? `${h.name ?? h.userId ?? '某位同学'}正在使用（${new Date(h.until).toLocaleTimeString('zh-CN', { hour12: false })} 前）` : null,
        action: action ? { action_id: action.action_id, location: action.label, state: action.state, reason: action.reason } : undefined,
      };
    },
  });

  // ------------------------------------------------------------ 地点表
  reg(runtime, {
    name: 'temi_locations',
    description:
      '机器人地点表（也是白名单）：list 列出能去的地点；save 把机器人「当前所在位置」存成新地点（可绑定成某位同学的工位）；' +
      'update 改显示名 / 别名 / 绑定；delete 删除地点（要确认）。',
    schema: z.object({
      action: z.enum(['list', 'save', 'update', 'delete']),
      name: z.string().optional().describe('save：机器人地图上的名字；update / delete：要改的地点'),
      label: z.string().optional(),
      aliases: z.array(z.string()).optional(),
      kind: z.enum(['room', 'workstation', 'dock', 'other']).optional(),
      owner: z.string().optional().describe('工位主人：人名或 user_id'),
    }),
    risk: (i) => (i.action === 'list' ? 'read' : i.action === 'delete' ? 'destructive' : 'write'),
    label: (i) => `机器人地点 · ${{ list: '列出', save: '保存', update: '修改', delete: '删除' }[i.action]}`,
    preview: async (i) => `将从机器人地点表删除「${i.name ?? ''}」，之后机器人不能再去这里。`,
    async run(i, ctx) {
      if (i.action === 'list') {
        const items = await rc.locations.list();
        return { ok: true, items: items.map((l) => ({ name: l.name, label: l.label, aliases: l.aliases, kind: l.kind, owner_user_id: l.owner_user_id ?? undefined, allowed: l.allowed })) };
      }
      if (!cos) return { ok: false, error: '没有连上平台，地点表只能查看' };
      if (!i.name) return { ok: false, error: `action=${i.action} 需要 name` };
      const call = callFor(cos, ctx);
      let ownerId: string | undefined;
      if (i.owner) {
        const p = await resolvePeople(call, [i.owner]);
        const hit = p.found[i.owner];
        if (!hit) return { ok: false, code: 'PEOPLE_UNRESOLVED', error: `找不到唯一的「${i.owner}」，请用 user_id`, details: p };
        ownerId = hit.user_id;
      }
      const base = `/robots/${encodeURIComponent(rc.robotId)}/locations`;
      const body = { name: i.name, label: i.label, aliases: i.aliases, kind: i.kind ?? (ownerId ? 'workstation' : undefined), owner_user_id: ownerId };
      if (i.action === 'save') {
        const saved = await rc.sidecar.saveLocation(i.name);
        if (!saved.ok) return { ok: false, error: `机器人没能保存当前位置：${saved.error}` };
        const r = await call('POST', base, { body });
        rc.locations.invalidate();
        rc.log({ kind: 'location', text: `保存地点「${i.label ?? i.name}」`, actor_id: ctx.actor?.userId, ok: r.ok });
        return r.ok ? { ok: true, summary: `已把当前位置存为「${i.label ?? i.name}」`, data: r.data } : { ok: false, error: r.error, code: r.code };
      }
      const path = `${base}/${encodeURIComponent(i.name)}`;
      if (i.action === 'update') {
        const r = await call('PATCH', path, { body });
        rc.locations.invalidate();
        return r.ok ? { ok: true, summary: '已更新地点', data: r.data } : { ok: false, error: r.error, code: r.code };
      }
      const r = await call('DELETE', path);
      if (r.ok) await rc.sidecar.deleteLocation(i.name);
      rc.locations.invalidate();
      return r.ok ? { ok: true, summary: `已删除地点「${i.name}」` } : { ok: false, error: r.error, code: r.code };
    },
  });

  // ------------------------------------------------------------ 组合动作
  const taskSchema = z.object({
    kind: z.enum(['deliver_message', 'find_person', 'guide_visitor']),
    to_user: z.string().optional().describe('deliver_message / find_person：人名或 user_id'),
    text: z.string().max(300).optional().describe('deliver_message：要转告的话'),
    stops: z
      .array(z.object({ location: z.string(), say: z.string().max(500).optional() }))
      .max(10)
      .optional()
      .describe('guide_visitor：依次去的地点和到达后的讲解'),
    return_home: z.boolean().default(true).describe('做完是否回充电桩'),
    fallback_im: z.boolean().default(true).describe('deliver_message：人不在工位时改发私信'),
  });
  type TaskInput = z.infer<typeof taskSchema>;

  async function findTarget(i: TaskInput, ctx: ToolCallContext): Promise<{ user_id: string; name: string; desk: Awaited<ReturnType<typeof rc.locations.workstationOf>> } | Result> {
    if (!i.to_user) return { ok: false, error: '需要 to_user' };
    if (!cos) return { ok: false, error: '没有连上平台，查不到同学的工位' };
    const p = await resolvePeople(callFor(cos, ctx), [i.to_user]);
    const hit = p.found[i.to_user];
    if (!hit) return { ok: false, code: 'PEOPLE_UNRESOLVED', error: `找不到唯一的「${i.to_user}」，请向同学确认`, details: p };
    const desk = await rc.locations.workstationOf(hit.user_id);
    if (!desk) return { ok: false, code: 'NO_WORKSTATION', error: `${hit.name} 还没有在机器人地点表里绑定工位。可以让 Temi 走到他的工位后用 temi_locations save（owner=${hit.name}）绑定` };
    return { user_id: hit.user_id, name: hit.name, desk };
  }

  async function goHome(actor: GuardActor, steps: string[]) {
    const home = (await rc.locations.list()).find((l) => l.kind === 'dock');
    if (!home) return;
    const r = await rc.goto(actor, home.name, { wait: false });
    steps.push(r.ok ? `返回「${home.label}」` : `没能返回充电桩：${r.error}`);
  }

  reg(runtime, {
    name: 'temi_task',
    description:
      'Temi 组合任务（一次确认，自动走完）：' +
      'deliver_message 去某位同学的工位当面转告一句话，人不在就改发私信；' +
      'find_person 去工位看看某人在不在；guide_visitor 按 stops 依次带访客参观并讲解。',
    schema: taskSchema,
    risk: () => 'physical',
    label: (i) => ({ deliver_message: `Temi 给${i.to_user ?? ''}送话`, find_person: `Temi 找${i.to_user ?? ''}`, guide_visitor: 'Temi 带参观' })[i.kind],
    preview: async (i) => {
      const what =
        i.kind === 'deliver_message'
          ? `去 ${i.to_user ?? '?'} 的工位转告：「${i.text ?? ''}」`
          : i.kind === 'find_person'
            ? `去 ${i.to_user ?? '?'} 的工位看看人在不在`
            : `依次带参观：${(i.stops ?? []).map((s) => s.location).join(' → ')}`;
      return `让 Temi ${what}${i.return_home ? '，结束后回充电桩' : ''}。${MOVE_NOTE}`;
    },
    async run(i, ctx) {
      const actor = actorOf(ctx);
      const steps: string[] = [];
      if (i.kind === 'guide_visitor') {
        if (!i.stops?.length) return { ok: false, error: 'guide_visitor 需要 stops' };
        for (const s of i.stops) {
          if (ctx.signal?.aborted) return { ok: false, aborted: true, steps, error: '已中断' };
          const r = await rc.goto(actor, s.location);
          if (!r.ok) return { ok: false, steps, error: r.error, code: r.code };
          if (!r.arrived) return { ok: false, steps, error: '仍在导航，尚未确认到达', action_id: r.action_id };
          steps.push(`到达「${r.label}」`);
          if (s.say) {
            await rc.sidecar.say(s.say);
            steps.push('讲解完毕');
          }
        }
        if (i.return_home) await goHome(actor, steps);
        rc.release(actor);
        return { ok: true, steps, summary: `参观结束，共 ${i.stops.length} 站` };
      }

      const t = await findTarget(i, ctx);
      if ('ok' in t) return t;
      if (i.kind === 'deliver_message' && !i.text) return { ok: false, error: 'deliver_message 需要 text' };
      const r = await rc.goto(actor, t.desk!.name);
      if (!r.ok) return { ok: false, steps, code: r.code, error: r.error };
      if (!r.arrived) return { ok: false, steps, error: '仍在导航，尚未确认到达', action_id: r.action_id };
      steps.push(`到达${t.name}的工位「${r.label}」`);
      const seen = await rc.sidecar.detectPerson(5_000);
      const present = !!(seen.ok && seen.data?.present);
      steps.push(present ? '看到有人' : '工位上没人');

      const result: Result = { ok: true, person: t.name, present, steps };
      if (i.kind === 'deliver_message') {
        const from = ctx.actor?.name ?? '有同学';
        if (present) {
          await rc.sidecar.say(`${t.name}你好，${from}让我转告你：${i.text}`);
          const ack = await rc.sidecar.ask('收到了吗？');
          result.delivered = 'in_person';
          result.reply = ack.ok ? (ack.data?.reply ?? null) : null;
          steps.push(result.reply ? `${t.name}回答：${String(result.reply)}` : '转告完毕（没听到回答）');
        } else if (i.fallback_im && cos) {
          // 人不在：不在空工位大声念别人的话，改发私信
          const sent = await botSend(cos, callFor(cos, ctx), ctx, { user_id: t.user_id }, `【Temi 代 ${from} 转告】${i.text}`);
          result.delivered = sent.ok ? 'im' : 'failed';
          steps.push(sent.ok ? '人不在，已改发私信' : `人不在，私信也没发出去：${sent.error}`);
        } else {
          result.delivered = 'failed';
        }
      }
      rc.log({ kind: 'task', text: `${i.kind === 'deliver_message' ? '送话' : '找人'}：${t.name}（${present ? '在' : '不在'}）`, actor_id: ctx.actor?.userId, ok: true });
      if (i.return_home) await goHome(actor, steps);
      rc.release(actor);
      return result;
    },
  });
}

export const ROBOT_TOOLS_PROMPT = [
  '## Temi 机器人',
  '- 用 temi_* 工具直接操控机器人：temi_say 说话、temi_ask 当面提问、temi_goto 去某地、temi_move 转身抬头、temi_follow 跟随、temi_look 看一眼、temi_status 查状态。',
  '- 同学说「停」「别动」「快停下」时立刻调用 temi_stop，不用任何确认。',
  '- 地点只能用 temi_locations list 里的；同学说的地点找不到时，告诉他有哪些地点，不要编造。',
  '- 「让 Temi 去提醒/告诉某人……」用 temi_task kind=deliver_message；「看看某人在不在」用 kind=find_person；带人参观用 kind=guide_visitor。',
  '- 移动会弹确认卡片；被安全规则拦下（电量低、别人在用、夜间禁行）时，把原因原样告诉同学，不要反复重试。',
  '- 机器人是模拟模式（mock=true）时，要告诉同学这次没有真的动。',
].join('\n');
