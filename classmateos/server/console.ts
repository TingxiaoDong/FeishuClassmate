/**
 * 极简网页控制台（开发联调用）：单文件 HTML + vanilla JS，
 * 挂在 /console，直连 ClassmateOS API。
 * 覆盖：登录、会话列表 + 实时消息（WS）、表格记录浏览、文档查看。
 * Flutter 四端 UI 是 PLAN 的正式界面；本页仅供无 Flutter SDK 环境下试用。
 */

const HTML = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ClassmateOS 控制台</title>
<style>
  :root { --bd:#e2e2e8; --bg:#f7f7fa; --pri:#4f6ef7; }
  * { box-sizing: border-box; font-family: -apple-system, "PingFang SC", sans-serif; }
  body { margin:0; background:var(--bg); color:#222; }
  #login { max-width:320px; margin:15vh auto; background:#fff; padding:28px; border-radius:12px; box-shadow:0 2px 12px #0001; }
  #login input { width:100%; padding:9px; margin:6px 0 12px; border:1px solid var(--bd); border-radius:8px; }
  button { background:var(--pri); color:#fff; border:0; padding:9px 18px; border-radius:8px; cursor:pointer; }
  #app { display:none; height:100vh; grid-template-columns:190px 1fr; }
  nav { background:#fff; border-right:1px solid var(--bd); padding:14px 10px; }
  nav .item { padding:9px 12px; border-radius:8px; cursor:pointer; margin-bottom:4px; }
  nav .item.on { background:#eef1fe; color:var(--pri); font-weight:600; }
  nav .who { font-size:12px; color:#888; margin:0 4px 14px; }
  main { padding:18px; overflow:auto; }
  .card { background:#fff; border:1px solid var(--bd); border-radius:10px; padding:14px; margin-bottom:14px; }
  .row { display:flex; gap:8px; margin-bottom:10px; }
  .row input, .row select { flex:1; padding:8px; border:1px solid var(--bd); border-radius:8px; }
  #msgs { height:46vh; overflow:auto; background:#fafafc; border:1px solid var(--bd); border-radius:8px; padding:10px; }
  .m { margin:6px 0; } .m .who { font-size:11px; color:#999; }
  .m .b { display:inline-block; background:#eef1fe; padding:7px 11px; border-radius:10px; max-width:70%; word-break:break-all; }
  table { border-collapse:collapse; width:100%; font-size:13px; }
  td, th { border:1px solid var(--bd); padding:6px 8px; text-align:left; max-width:220px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  th { background:#f0f0f6; }
  .pill { font-size:12px; background:#eef1fe; color:var(--pri); padding:2px 8px; border-radius:10px; margin-right:6px; cursor:pointer; }
  pre { background:#fafafc; padding:10px; border-radius:8px; overflow:auto; font-size:13px; }
</style>
</head>
<body>
<div id="login">
  <h2 style="margin:0 0 16px">ClassmateOS</h2>
  <input id="u" placeholder="用户名（admin / demo）" value="admin" />
  <input id="p" type="password" placeholder="密码" value="admin" />
  <button onclick="login()" style="width:100%">登录</button>
  <div id="err" style="color:#d33;font-size:13px;margin-top:8px"></div>
</div>

<div id="app">
  <nav>
    <div class="who" id="who"></div>
    <div class="item on" data-v="chat" onclick="show('chat')">💬 聊天</div>
    <div class="item" data-v="tables" onclick="show('tables')">📊 多维表</div>
    <div class="item" data-v="docs" onclick="show('docs')">📄 文档</div>
    <div class="item" data-v="dash" onclick="show('dash')">📈 报表</div>
  </nav>
  <main>
    <section id="v-chat">
      <div class="row">
        <select id="chats" onchange="loadMsgs()"></select>
        <button onclick="newChat()">＋ 新会话</button>
      </div>
      <div id="msgs"></div>
      <div class="row" style="margin-top:10px">
        <input id="draft" placeholder="回车发送" onkeydown="if(event.key==='Enter')sendMsg()" />
        <button onclick="sendMsg()">发送</button>
      </div>
    </section>
    <section id="v-tables" style="display:none">
      <div id="tablePills" class="card"></div>
      <div class="card"><div id="records">选择上方一张表</div></div>
    </section>
    <section id="v-docs" style="display:none">
      <div class="row"><input id="docTitle" placeholder="新文档标题" /><button onclick="newDoc()">＋ 建文档</button></div>
      <div id="docList"></div>
    </section>
    <section id="v-dash" style="display:none"><div class="card"><pre id="dashOut">加载中…</pre></div></section>
  </main>
</div>

<script>
const API = '/api/v1';
let token = '', me = {}, ws = null;

async function api(path, opts = {}) {
  const r = await fetch(API + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, ...(opts.headers || {}) },
  });
  if (r.status === 204) return null;
  const d = await r.json();
  if (!r.ok) throw new Error(d.message || r.status);
  return d;
}

async function login() {
  try {
    const r = await fetch(API + '/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: u.value, password: p.value }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.message);
    token = d.access_token;
    me = await api('/users/me');
    document.getElementById('login').style.display = 'none';
    document.getElementById('app').style.display = 'grid';
    who.textContent = me.name + '（' + me.role + '）';
    connectWs(); loadChats();
  } catch (e) { err.textContent = '登录失败：' + e.message; }
}

function show(v) {
  document.querySelectorAll('nav .item').forEach(i => i.classList.toggle('on', i.dataset.v === v));
  ['chat','tables','docs','dash'].forEach(x => document.getElementById('v-' + x).style.display = x === v ? '' : 'none');
  if (v === 'tables') loadTables();
  if (v === 'docs') loadDocs();
  if (v === 'dash') api('/dashboard/summary').then(d => dashOut.textContent = JSON.stringify(d, null, 2));
}

// ---------- 聊天 ----------
function connectWs() {
  ws = new WebSocket('ws://' + location.host + API + '/events/ws?token=' + token);
  ws.onmessage = () => { loadMsgs(); };
}
async function loadChats() {
  const d = await api('/chats');
  chats.innerHTML = d.items.map(c => '<option value="' + c.chat_id + '">' + (c.name || c.chat_id) + '</option>').join('');
  if (d.items.length) loadMsgs();
}
async function newChat() {
  const name = prompt('会话名（将拉上 demo 用户）');
  if (!name) return;
  await api('/chats', { method: 'POST', body: JSON.stringify({ name, member_ids: ['ou_admin', 'ou_demo'] }) });
  loadChats();
}
async function loadMsgs() {
  const id = chats.value; if (!id) return;
  const d = await api('/chats/' + id + '/messages');
  msgs.innerHTML = d.items.reverse().map(m =>
    '<div class="m"><div class="who">' + m.sender_id + ' · ' + new Date(m.created_at).toLocaleTimeString() +
    '</div><div class="b">' + (m.content.text || JSON.stringify(m.content)) + '</div></div>').join('');
  msgs.scrollTop = msgs.scrollHeight;
}
async function sendMsg() {
  if (!draft.value.trim() || !chats.value) return;
  await api('/chats/' + chats.value + '/messages', {
    method: 'POST', body: JSON.stringify({ msg_type: 'text', content: { text: draft.value } }),
  });
  draft.value = '';
}

// ---------- 多维表 ----------
async function loadTables() {
  const d = await api('/tables');
  tablePills.innerHTML = d.items.map(t => '<span class="pill" onclick="loadRecords(\\'' + t.key + '\\')">' + t.name + '</span>').join('');
}
async function loadRecords(key) {
  const d = await api('/tables/' + key + '/records');
  if (!d.items.length) { records.innerHTML = '（空表）'; return; }
  const cols = [...new Set(d.items.flatMap(r => Object.keys(r.fields)))];
  records.innerHTML = '<table><tr>' + cols.map(c => '<th>' + c + '</th>').join('') + '</tr>' +
    d.items.map(r => '<tr>' + cols.map(c => '<td>' + fmt(r.fields[c]) + '</td>').join('') + '</tr>').join('') + '</table>';
}
const fmt = v => v === undefined ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));

// ---------- 文档 ----------
async function loadDocs() {
  const d = await api('/docs');
  docList.innerHTML = d.items.map(x =>
    '<div class="card"><b>' + x.title + '</b> <span style="color:#999;font-size:12px">' + x.doc_id + '</span>' +
    '<button style="float:right" onclick="viewDoc(\\'' + x.doc_id + '\\')">查看</button><pre id="doc-' + x.doc_id + '" style="display:none"></pre></div>').join('') || '还没有文档';
}
async function viewDoc(id) {
  const el = document.getElementById('doc-' + id);
  if (el.style.display === 'none') { el.textContent = (await api('/docs/' + id)).markdown; el.style.display = ''; }
  else el.style.display = 'none';
}
async function newDoc() {
  if (!docTitle.value.trim()) return;
  await api('/docs', { method: 'POST', body: JSON.stringify({ title: docTitle.value, markdown: '# ' + docTitle.value + '\\n' }) });
  docTitle.value = ''; loadDocs();
}
</script>
</body>
</html>
`;

import type { FastifyInstance } from 'fastify';

export function registerConsole(app: FastifyInstance): void {
  app.get('/console', async (_req, reply) => {
    reply.header('content-type', 'text/html; charset=utf-8');
    return HTML;
  });
}
