/**
 * Temi 语音通道 + App 急停桥（AGENT_PLAN M4 §3.2 / §3.5）。
 *
 * 语音通道：机器人识别到的话（asr 事件）→ 大脑 → 回答由 Temi 播报。
 *   - 说话的人是访客，不带同学身份：平台工具会拒绝，保密数据拿不到；
 *   - 不提供确认通道：需要确认的动作（让机器人走动等）一律跳过；
 *   - 同一时间只处理一句，忙时告诉对方稍等；5 分钟没人说话清空上下文；
 *   - 回答去掉 Markdown、截到适合播报的长度。
 *
 * 急停桥：平台的 robot.estop 事件（App 一键急停）→ controller.stop，不经过任何确认。
 */

import type { AgentRuntime, ChatMessage } from '../runtime/types.js';
import type { BotEventSource } from '../pal/bot-events.js';
import type { RobotController } from './controller.js';
import type { RobotEvent } from './sidecar.js';

/**
 * 访客身份：userId 为空字符串。CosClient 只在 userId 为 undefined 时才退回服务账号
 * （defaultUserId），空字符串会直接返回 NO_ACTOR —— 访客借不到任何同学或服务账号的权限。
 */
export const VISITOR_ACTOR = Object.freeze({ userId: '', name: '访客' });

export const VOICE_SYSTEM_PROMPT = [
  '你是飞书同学，实验室的 Temi 机器人，现在正在和面前的人语音对话（对方多半是访客）。',
  '回答用口语，一到三句话，不要用列表、表格、Markdown、链接或表情。',
  '你不知道对方是谁，不要透露任何同学的个人信息、日程或实验室内部数据。',
  '需要带路或走动时，告诉对方请实验室同学在 App 里让你去，不要自己移动。',
].join('\n');

export interface VoiceChannelOptions {
  controller: RobotController;
  runtime: AgentRuntime;
  systemPrompt?: string;
  /** 每次播报最多多少字，默认 150。 */
  maxSpeechChars?: number;
  /** 多久没人说话清空上下文，默认 5 分钟。 */
  idleResetMs?: number;
  /** 最多保留几轮对话，默认 6。 */
  maxTurns?: number;
  now?: () => number;
  onLog?: (m: string) => void;
  onError?: (e: unknown) => void;
}

export interface VoiceChannel {
  /** 处理一句识别结果（测试也直接调它）。 */
  handle(text: string): Promise<string | undefined>;
  stop(): void;
}

/** 把模型回答整理成适合播报的话。 */
export function toSpeech(text: string, max = 150): string {
  let s = text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/cos:\/\/\S+/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_`#>|~]/g, '')
    .replace(/^\s*[-+]\s+/gm, '')
    .replace(/([。！？；，])\s*\n+\s*/g, '$1')
    .replace(/\s*\n+\s*/g, '，')
    .replace(/，{2,}/g, '，')
    .trim()
    .replace(/^，|，$/g, '');
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const end = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'));
  return end > max / 3 ? cut.slice(0, end + 1) : `${cut}……`;
}

export function createVoiceChannel(opts: VoiceChannelOptions): VoiceChannel {
  const now = opts.now ?? Date.now;
  const max = opts.maxSpeechChars ?? 150;
  const idle = opts.idleResetMs ?? 5 * 60_000;
  const keep = (opts.maxTurns ?? 6) * 2;
  let history: ChatMessage[] = [];
  let lastAt = 0;
  let busy = false;
  let sessionId = '';
  let stopped = false;

  const say = async (text: string) => {
    const r = await opts.controller.sidecar.say(text);
    opts.controller.log({ kind: 'say', text: `语音回答：${text.slice(0, 60)}`, ok: r.ok });
  };

  async function handle(raw: string): Promise<string | undefined> {
    const text = raw.trim();
    if (stopped || !text) return undefined;
    if (busy) {
      await say('我还在想上一个问题，请稍等一下。').catch(opts.onError);
      return undefined;
    }
    busy = true;
    try {
      if (!sessionId || now() - lastAt > idle) {
        history = [];
        sessionId = `temi_${new Date(now()).toISOString().slice(0, 10)}_${now()}`;
      }
      lastAt = now();
      opts.onLog?.(`[temi-voice] 听到：${text}`);
      history.push({ role: 'user', content: text });
      const res = await opts.runtime.runSession({
        sessionId,
        messages: history.slice(-keep),
        systemPrompt: opts.systemPrompt ?? VOICE_SYSTEM_PROMPT,
        actor: { ...VISITOR_ACTOR },
        maxTurns: 6,
      });
      const speech = toSpeech(res.output || '', max) || '这个问题我暂时回答不了，可以问问实验室的同学。';
      history.push({ role: 'assistant', content: speech });
      history = history.slice(-keep);
      lastAt = now();
      await say(speech);
      return speech;
    } catch (e) {
      opts.onError?.(e);
      history.pop();
      await say('抱歉，我刚才没想明白，请再说一遍。').catch(() => {});
      return undefined;
    } finally {
      busy = false;
    }
  }

  const unsub = opts.controller.onEvent((e: RobotEvent) => {
    if (e.type === 'asr' && e.text) void handle(e.text).catch(opts.onError);
  });

  return {
    handle,
    stop() {
      stopped = true;
      unsub();
    },
  };
}


/** App 急停 → 机器人急停。返回取消订阅函数。 */
export function bridgePlatformEstop(source: Pick<BotEventSource, 'onEvent'>, controller: RobotController, onError?: (e: unknown) => void): () => void {
  return source.onEvent((ev) => {
    // robot.estop 不在 BotEventPayload 的联合类型里（只有网关以外的订阅者关心），按宽类型读
    const e = ev as unknown as Record<string, unknown>;
    if (e.event_type !== 'robot.estop') return;
    if (e.robot_id && e.robot_id !== controller.robotId) return;
    void controller
      .stop({ userId: typeof e.user_id === 'string' ? e.user_id : undefined, name: typeof e.name === 'string' ? e.name : undefined, source: 'app' })
      .catch(onError);
  });
}
