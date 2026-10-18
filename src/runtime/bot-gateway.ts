/**
 * Bot 网关（PLAN §2.4）：平台 WS 事件 → 大脑 runtime → 平台消息。
 *
 * 接法（与 PLAN 一致）：
 *   平台 message.receive (WS) → 本网关 → runtime.runSession
 *   大脑输出 → PAL im.sendText → POST /bot/messages → 用户可见
 *
 * 会话策略：一个 chat_id 一个稳定 sessionId（`chat_<id>`），MetaClaw 按
 * session 维度蒸馏 skills（§0.2）。同一 chat 的消息串行处理（队列），
 * 避免并发会话互相覆盖上下文——PLAN §4 风险对策"会话层逻辑保持极简"。
 */

import type { AgentRuntime } from './types.js';
import type { BotEventSource, BotEventPayload } from '../pal/bot-events.js';
import type { ImService } from '../pal/types.js';

export interface BotGatewayOptions {
  runtime: AgentRuntime;
  eventSource: BotEventSource;
  im: ImService;
  onLog?: (msg: string) => void;
  onError?: (err: unknown) => void;
}

export interface BotGateway {
  start(): Promise<void>;
  stop(): void;
  /** 测试/诊断：处理单条消息事件。 */
  handleMessage(event: BotEventPayload): Promise<void>;
  /** 排队中的消息数（背压观测）。 */
  pendingCount(): number;
}

/** 从消息 content 提取用户可见文本；非文本消息返回占位描述。 */
export function extractText(msgType: string, content: Record<string, unknown>): string {
  if (msgType === 'text') return String(content.text ?? '');
  if (msgType === 'post') {
    // post 富文本：拼接所有 text 段
    const texts: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const seg of node) {
          if (seg && typeof seg === 'object' && (seg as { tag?: string }).tag === 'text') {
            texts.push(String((seg as { text?: string }).text ?? ''));
          }
        }
      }
    };
    walk(content.content);
    return texts.join('') || '[富文本消息]';
  }
  return `[${msgType} 消息]`;
}

export function createBotGateway(opts: BotGatewayOptions): BotGateway {
  const log = opts.onLog ?? (() => {});
  const onError = opts.onError ?? (() => {});
  // chat_id → 串行处理链（promise chaining 实现每会话串行）
  const chains = new Map<string, Promise<void>>();
  let pending = 0;
  let unsubscribe: (() => void) | undefined;

  async function process(event: BotEventPayload): Promise<void> {
    const msg = event.message;
    if (!msg) return;
    const chatId = String(msg.chat_id ?? '');
    const senderId = String(msg.sender_id ?? '');
    if (!chatId || senderId === 'bot') return; // bot 自己的消息不回环

    const text = extractText(String(msg.msg_type ?? 'text'), (msg.content as Record<string, unknown>) ?? {});
    if (!text.trim()) return;

    log(`[bot-gateway] message from ${senderId} in ${chatId}: ${text.slice(0, 80)}`);
    const res = await opts.runtime.runSession({
      sessionId: `chat_${chatId}`,
      messages: [{ role: 'user', content: text }],
    });

    if (res.output.trim()) {
      const sent = await opts.im.sendText(chatId, res.output);
      if (!sent.ok) onError(new Error(`reply send failed: ${sent.error}`));
    }
  }

  async function handleMessage(event: BotEventPayload): Promise<void> {
    const chatId = String(event.message?.chat_id ?? '');
    pending += 1;
    const prev = chains.get(chatId) ?? Promise.resolve();
    const next = prev
      .then(() => process(event))
      .catch(onError)
      .finally(() => {
        pending -= 1;
      });
    chains.set(chatId, next);
    await next;
  }

  return {
    async start() {
      unsubscribe = opts.eventSource.onEvent((event) => {
        if (event.event_type === 'message.receive') {
          void handleMessage(event);
        }
      });
      await opts.eventSource.connect();
      log('[bot-gateway] started');
    },
    stop() {
      unsubscribe?.();
      opts.eventSource.close();
    },
    handleMessage,
    pendingCount: () => pending,
  };
}
