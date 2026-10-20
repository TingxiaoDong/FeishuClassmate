/**
 * Agent 评测（AGENT_PLAN M2）：每道题起一个全新的内存版 ClassmateOS，经真实 Bot 网关 + 真实大模型跑完，
 * 确认卡片按题目要求由「同学」在平台上点按钮（走服务端核验），最后以同学身份查平台状态打分。
 *
 *   pnpm tsx scripts/run-evals.ts                 全部题目
 *   pnpm tsx scripts/run-evals.ts table-create    只跑 id 含该词的题
 *
 *   pnpm eval --check                             只检查大模型连得上（Key 对不对），不跑题
 *
 * 环境变量（启动时自动读项目根目录的 .env）：
 *           DEEPSEEK_API_KEY（直连 DeepSeek，默认 deepseek-chat），或 METACLAW_URL / METACLAW_API_KEY（经 MetaClaw 代理）；
 *           CLASSMATE_MODEL 指定模型名；
 *           机器人题（requires: temi）用 M4 模拟机器人跑，不需要真机；EVAL_TEMI=0 时跳过；
 *           EVAL_MIN_PASS=0.8 低于该通过率时退出码 1。
 * 报告写到 evals/results/<时间>.json 和同名 .md（按类别的通过率）。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { MetaClawLlmClient, type LlmClientLike } from '../src/runtime/llm-client.js';
import { llmEnvProblem, loadDotEnv, resolveLlmEnv } from '../src/runtime/llm-env.js';
import { buildApp, type PlatformUser } from '../classmateos/server/app.js';
import { createBrain } from '../src/runtime/brain.js';
import { createBotGateway } from '../src/runtime/bot-gateway.js';
import { MemorySessionStore, llmSummarizer } from '../src/runtime/session-store.js';
import { createClassmateOSAdapter } from '../src/pal/classmateos-adapter.js';
import type { BotEventSource } from '../src/pal/bot-events.js';
import type { ImService } from '../src/pal/types.js';
import type { AgentRuntime, RunSessionResult } from '../src/runtime/types.js';
import { actionOf, fill, placeholders, scoreCase, validateCases, type EvalCase, type EvalFile, type Observed } from '../src/evals/score.js';

const USERS: PlatformUser[] = [
  { user_id: 'ou_admin', name: '管理员', password: 'admin', role: 'admin' },
  { user_id: 'u_zhang', name: '张晓明', password: 'pw', role: 'member' },
  { user_id: 'u_li', name: '李华', password: 'pw', role: 'member' },
];
const ME = 'u_zhang';
const BOT_TOKEN = 'eval-bot-token';
const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

const nullSource: BotEventSource = { connect: async () => {}, close: () => {}, onEvent: () => () => {} };

export interface CaseResult {
  id: string;
  category: string;
  status: 'pass' | 'fail' | 'skip' | 'error';
  failures: string[];
  calls?: Observed['calls'];
  confirmAsked?: boolean;
  output?: string;
  ms: number;
}

/** 跑一道题。opts.llm：测试时注入脚本化的模型。 */
export async function runCase(c: EvalCase, opts: { llm?: LlmClientLike } = {}): Promise<CaseResult> {
  const started = Date.now();
  let robot: { close(): void } | undefined;
  const app = await buildApp({ users: USERS, secret: 'eval', botToken: BOT_TOKEN, notificationScanner: false });
  try {
    const addr = await app.listen({ port: 0, host: '127.0.0.1' });
    const baseUrl = `${addr}/api/v1`;
    const vars = placeholders();
    const tokens = new Map<string, string>();
    const tokenOf = async (uid: string) => {
      if (!tokens.has(uid)) {
        const u = USERS.find((x) => x.user_id === uid)!;
        const r = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: uid, password: u.password } });
        tokens.set(uid, r.json().access_token);
      }
      return tokens.get(uid)!;
    };
    const as = async (uid: string, method: string, path: string, body?: unknown) =>
      app.inject({ method: method as 'GET', url: `/api/v1${path}`, headers: { authorization: `Bearer ${await tokenOf(uid)}` }, payload: body as object });

    for (const s of c.setup ?? []) {
      const r = await as(s.as, s.method, fill(s.path, vars), fill(s.body, vars));
      if (r.statusCode >= 400) throw new Error(`setup ${s.method} ${s.path} → ${r.statusCode} ${r.body.slice(0, 200)}`);
      for (const [k, field] of Object.entries(s.save ?? {})) {
        const v = (r.json() as Record<string, unknown>)[field];
        if (typeof v !== 'string' && typeof v !== 'number') throw new Error(`setup ${s.path} 的返回里没有 ${field}`);
        vars[k] = v;
      }
    }
    // M5：侧栏题每句都带着当前对象发出
    const agentContext = c.context ? fill(c.context, vars) : undefined;

    // 机器人题：临时打开 M4 模拟机器人（MockSidecar，不会动真机）
    const wantsRobot = c.requires?.includes('temi') ?? false;
    const prevM4 = process.env.CLASSMATE_ROBOT_M4;
    const prevMock = process.env.TEMI_MOCK;
    if (wantsRobot) {
      process.env.CLASSMATE_ROBOT_M4 = '1';
      process.env.TEMI_MOCK = '1';
    }
    let brain: ReturnType<typeof createBrain>;
    try {
      brain = createBrain({ llm: opts.llm, skillsDir: process.env.CLASSMATE_SKILLS_DIR ?? 'skills', logger: silent, telemetry: false, cos: { baseUrl, botToken: BOT_TOKEN } });
    } finally {
      if (wantsRobot) {
        restoreEnv('CLASSMATE_ROBOT_M4', prevM4);
        restoreEnv('TEMI_MOCK', prevMock);
      }
    }
    robot = brain.robot;

    // 记下每轮的运行结果
    const results: RunSessionResult[] = [];
    const runtime: AgentRuntime = new Proxy(brain.runtime, {
      get(t, p) {
        if (p === 'runSession') {
          return async (input: Parameters<AgentRuntime['runSession']>[0]) => {
            const r = await t.runSession(input);
            results.push(r);
            return r;
          };
        }
        const v = (t as unknown as Record<PropertyKey, unknown>)[p];
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    }) as AgentRuntime;

    // 发确认卡片时：由同学在平台上点按钮，再把卡片事件交给网关
    const pal = createClassmateOSAdapter({ baseUrl, botToken: BOT_TOKEN });
    let confirmAsked = false;
    let gateway: ReturnType<typeof createBotGateway>;
    const answer = c.confirm_answer === 'reject' ? '取消' : '确认';
    const im: ImService = new Proxy(pal.im, {
      get(t, p) {
        if (p === 'sendMessage') {
          return async (params: Parameters<ImService['sendMessage']>[0]) => {
            const r = await t.sendMessage(params);
            const content = params.content as { kind?: string; card_id?: string };
            if (r.ok && params.msgType === 'interactive_card' && content.kind === 'confirm' && content.card_id) {
              confirmAsked = true;
              const cardId = content.card_id;
              setTimeout(() => {
                void (async () => {
                  const clicked = await as(ME, 'POST', `/cards/${encodeURIComponent(cardId)}/actions`, { action: answer });
                  if (clicked.statusCode >= 400) console.warn(`  [${c.id}] 点卡片失败 ${clicked.statusCode} ${clicked.body.slice(0, 120)}`);
                  await gateway.handleEvent({ event_type: 'card.action', card_action: { card_id: cardId, user_id: ME, action: answer } } as never);
                })();
              }, 30);
            }
            return r;
          };
        }
        const v = (t as unknown as Record<PropertyKey, unknown>)[p];
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    }) as ImService;

    gateway = createBotGateway({
      runtime,
      eventSource: nullSource,
      im,
      sessionStore: new MemorySessionStore(),
      summarize: llmSummarizer(brain.llm),
      systemPromptFor: brain.systemPromptFor,
      progressDelayMs: false,
      confirmTimeoutMs: 60_000,
      onError: (e) => console.warn(`  [${c.id}]`, e instanceof Error ? e.message : e),
    });

    // 同学和机器人的私聊
    const hello = await pal.im.sendText(ME, '（评测开始）', 'user_id');
    if (!hello.ok) throw new Error(`建私聊失败：${hello.error}`);
    const chatId = hello.value.chatId;

    for (const [i, text] of c.turns.entries()) {
      if (i === c.turns.length - 1) confirmAsked = false;
      const content = agentContext ? { text, agent_context: agentContext } : { text };
      const posted = await as(ME, 'POST', `/chats/${encodeURIComponent(chatId)}/messages`, { msg_type: 'text', content });
      const messageId = posted.statusCode < 400 ? posted.json().message_id : `eval_${i}`;
      await gateway.handleMessage({
        event_type: 'message.receive',
        message: { message_id: messageId, chat_id: chatId, sender_id: ME, msg_type: 'text', content },
      } as never);
    }

    const last = results.at(-1);
    if (!last) throw new Error('网关没有调用大脑');
    const calls = last.messages
      .filter((m) => m.role === 'assistant' && m.toolCalls?.length)
      .flatMap((m) => m.toolCalls!.map((tc) => ({ name: tc.name, action: actionOf(tc.arguments) })));
    const state = [];
    for (const s of c.expect.state ?? []) {
      const r = await as(ME, 'GET', fill(s.path, vars));
      state.push({ status: r.statusCode, body: r.body });
    }
    const obs: Observed = { calls, confirmAsked, output: last.output ?? '', state };
    const score = scoreCase(c, obs);
    // 没通过时记下每次工具调用的参数和返回（截短），方便排查是模型的问题还是平台的问题
    const trace = score.pass
      ? undefined
      : last.messages
          .filter((m) => m.role === 'assistant' && m.toolCalls?.length)
          .flatMap((m) => m.toolCalls!)
          .map((tc) => {
            const res = last.messages.find((m) => m.role === 'tool' && (m as { toolCallId?: string }).toolCallId === tc.id);
            return { name: tc.name, args: tc.arguments.slice(0, 400), result: String(res?.content ?? '').slice(0, 400) };
          });
    return { id: c.id, category: c.category, status: score.pass ? 'pass' : 'fail', failures: score.failures, calls, ...(trace ? { trace } : {}), confirmAsked, output: obs.output.slice(0, 600), ms: Date.now() - started };
  } catch (err) {
    return { id: c.id, category: c.category, status: 'error', failures: [err instanceof Error ? err.message : String(err)], ms: Date.now() - started };
  } finally {
    robot?.close();
    await app.close();
  }
}

/** 正式跑题前先发一条很短的请求，Key 错、网络不通时马上停下。 */
export async function preflight(): Promise<string | undefined> {
  const env = resolveLlmEnv();
  const problem = llmEnvProblem(env);
  if (problem) return problem;
  const llm = new MetaClawLlmClient({ baseUrl: env.baseUrl, model: env.model, apiKey: env.apiKey, timeoutMs: 30_000 });
  try {
    await llm.chat({ messages: [{ role: 'user', content: '只回复 OK' }], sessionId: 'eval_preflight', turnType: 'user' });
    return undefined;
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status === 401 || status === 403) return `大模型拒绝了请求（HTTP ${status}）：API Key 不对或已失效`;
    if (status === 402) return '大模型账户余额不足（HTTP 402）';
    return `连不上大模型（${env.baseUrl}）：${e instanceof Error ? e.message : String(e)}`;
  }
}

function markdownReport(o: { at: string; provider: string; model: string; passed: number; total: number; skipped: number; byCat: Map<string, { p: number; n: number }>; results: CaseResult[] }): string {
  const pct = (p: number, n: number) => (n ? `${Math.round((p / n) * 100)}%` : '-');
  const lines = [
    `# Agent 评测报告`,
    ``,
    `- 时间：${o.at}`,
    `- 模型：${o.provider} / ${o.model}`,
    `- 总通过：${o.passed}/${o.total}（${pct(o.passed, o.total)}），跳过 ${o.skipped}`,
    ``,
    `| 类别 | 通过 | 题数 | 通过率 |`,
    `|---|---|---|---|`,
    ...[...o.byCat].map(([c, x]) => `| ${c} | ${x.p} | ${x.n} | ${pct(x.p, x.n)} |`),
    ``,
    `## 没通过的题`,
    ``,
  ];
  const bad = o.results.filter((r) => r.status === 'fail' || r.status === 'error');
  if (!bad.length) lines.push('无');
  for (const r of bad) lines.push(`- **${r.id}**（${r.category}）：${r.failures.join('；').slice(0, 400)}`);
  return lines.join('\n') + '\n';
}

async function main(): Promise<number> {
  const llmEnv = resolveLlmEnv();
  console.log(`大模型：${llmEnv.provider} / ${llmEnv.model}（${llmEnv.baseUrl}）`);
  const bad = await preflight();
  if (bad) {
    console.error(bad);
    return 2;
  }
  if (process.argv.includes('--check')) {
    console.log('大模型连接正常');
    return 0;
  }
  const file = JSON.parse(readFileSync('evals/agent-cases.json', 'utf8')) as EvalFile;
  const problems = validateCases(file);
  if (problems.length) {
    console.error('题目文件有问题：\n' + problems.join('\n'));
    return 2;
  }
  const filter = process.argv.slice(2).find((a) => !a.startsWith('--'));
  const cases = file.cases.filter((c) => !filter || c.id.includes(filter));
  const results: CaseResult[] = [];
  for (const c of cases) {
    if (c.requires?.includes('temi') && process.env.EVAL_TEMI === '0') {
      results.push({ id: c.id, category: c.category, status: 'skip', failures: ['EVAL_TEMI=0，跳过机器人题'], ms: 0 });
      console.log(`- ${c.id}  跳过`);
      continue;
    }
    process.stdout.write(`… ${c.id} `);
    const r = await runCase(c);
    results.push(r);
    console.log(`${r.status === 'pass' ? '✓' : '✗'} ${(r.ms / 1000).toFixed(1)}s${r.failures.length ? `\n    ${r.failures.join('\n    ')}` : ''}`);
  }

  const ran = results.filter((r) => r.status !== 'skip');
  const passed = ran.filter((r) => r.status === 'pass').length;
  const rate = ran.length ? passed / ran.length : 0;
  const byCat = new Map<string, { p: number; n: number }>();
  for (const r of ran) {
    const x = byCat.get(r.category) ?? { p: 0, n: 0 };
    x.n += 1;
    if (r.status === 'pass') x.p += 1;
    byCat.set(r.category, x);
  }
  console.log(`\n通过 ${passed}/${ran.length}（${(rate * 100).toFixed(0)}%），跳过 ${results.length - ran.length}`);
  for (const [cat, x] of byCat) console.log(`  ${cat}：${x.p}/${x.n}`);

  mkdirSync('evals/results', { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const at = new Date().toISOString();
  writeFileSync(
    `evals/results/${stamp}.json`,
    JSON.stringify({ at, provider: llmEnv.provider, model: llmEnv.model, passed, total: ran.length, rate, byCategory: Object.fromEntries(byCat), results }, null, 2),
  );
  writeFileSync(
    `evals/results/${stamp}.md`,
    markdownReport({ at, provider: llmEnv.provider, model: llmEnv.model, passed, total: ran.length, skipped: results.length - ran.length, byCat, results }),
  );
  console.log(`报告：evals/results/${stamp}.md`);
  const min = Number(process.env.EVAL_MIN_PASS ?? 0);
  return rate < min ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadDotEnv();
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
