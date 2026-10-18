#!/usr/bin/env node
/**
 * MetaClaw proxy 连通性检查（PLAN §5-2：skills_only 模式连通性实验）。
 *
 *   pnpm tsx scripts/check-metaclaw.mts [--url http://127.0.0.1:30000/v1] [--model kimi-k2]
 *
 * 验证 PLAN §0.2 的三个适配点：
 *   ① base_url 可达且是 OpenAI 兼容端点（POST /chat/completions）
 *   ② X-Session-Id / X-Turn-Type 头被接受（proxy 不拒绝自定义头）
 *   ③ POST /memory/flush_session 存在且返回 2xx/404 以外的明确响应
 * 退出码：0 全部通过；1 任一项失败。
 */

const args = process.argv.slice(2);
const argVal = (name: string, dflt: string): string => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

const baseUrl = (process.env.METACLAW_URL ?? argVal('--url', 'http://127.0.0.1:30000/v1')).replace(/\/+$/, '');
const model = process.env.CLASSMATE_MODEL ?? argVal('--model', 'kimi-k2');
const sessionId = `probe_${Date.now()}`;

let failures = 0;
const ok = (msg: string) => console.log(`  ✅ ${msg}`);
const fail = (msg: string) => {
  console.log(`  ❌ ${msg}`);
  failures += 1;
};

console.log(`MetaClaw probe → ${baseUrl} (model=${model})\n`);

// ① chat/completions 连通 + ② 自定义头
console.log('1) POST /chat/completions（带 X-Session-Id / X-Turn-Type）');
try {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Session-Id': sessionId,
      'X-Turn-Type': 'user',
      ...(process.env.METACLAW_API_KEY ? { Authorization: `Bearer ${process.env.METACLAW_API_KEY}` } : {}),
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: '回复"ok"两个字即可' }],
      max_tokens: 16,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    fail(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  } else {
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content ?? '';
    ok(`LLM 响应: ${JSON.stringify(content.slice(0, 50))}`);
  }
} catch (err) {
  fail(`连接失败: ${err instanceof Error ? err.message : err}`);
  console.log('\nproxy 未在运行？先启动 MetaClaw（skills_only 模式）再重试。');
  process.exit(1);
}

// ③ flush_session
console.log('2) POST /memory/flush_session');
try {
  const res = await fetch(`${baseUrl}/memory/flush_session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Session-Id': sessionId },
    body: JSON.stringify({ session_id: sessionId }),
    signal: AbortSignal.timeout(30_000),
  });
  if (res.ok) {
    ok(`flush_session HTTP ${res.status}`);
  } else if (res.status === 404) {
    fail('端点不存在 (404)——MetaClaw 版本过旧？需 v0.4.x');
  } else {
    fail(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
} catch (err) {
  fail(`请求失败: ${err instanceof Error ? err.message : err}`);
}

console.log(failures === 0 ? '\n全部通过 — 大脑可接线（pnpm classmate gateway）。' : `\n${failures} 项失败。`);
process.exit(failures === 0 ? 0 : 1);
