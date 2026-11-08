import { describe, it, expect } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { buildApp, type AppOptions } from '../../classmateos/server/app.js';
import { PgRepo } from '../../classmateos/server/pg-repo.js';
import { PgTableStore } from '../../classmateos/server/pg-store.js';
import { createTrustedScheduler, scheduleOccurrence } from '../../src/runtime/automation-scheduler-client.js';

// 真 HTTP + 真实 Agent 客户端；不是前端 UI 验收，也不是独立部署进程验收。
const pgUrl = process.env.CLASSMATEOS_TEST_PG_URL;
const modes = ['memory', ...(pgUrl ? ['postgres'] : [])];
describe.each(modes)('自动化真实网络联测 %s', mode => {
  it('隔离夹具：审批启用、同次重放、下一周期、ACL、撤销', async () => {
    const token = 'network-only-scheduler-token-1234567890';
    let pool: pg.Pool | undefined;
    const options: AppOptions = { secret: 'network-test', botToken: 'network-bot', notificationScanner: false,
      automationSchedulerToken: token,
      users: ['owner', 'reader', 'recipient'].map(user_id => ({ user_id, name: user_id, password: 'pw', role: 'member' as const })) };
    if (mode === 'postgres') {
      const url = new URL(pgUrl!);
      if (url.pathname !== '/cos_test' || !['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('仅允许本机 cos_test');
      pool = new pg.Pool({ connectionString: pgUrl });
      await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      await pool.query(await readFile(new URL('../../classmateos/schema.sql', import.meta.url), 'utf8'));
      const repo = new PgRepo(pool); await repo.init();
      const store = new PgTableStore(pool); await store.ensureMetaColumns();
      options.repo = repo; options.store = store;
    }
    await mkdir('_tmp', { recursive: true });
    const stateDir = await mkdtemp('_tmp/network-agent-');
    const app = await buildApp(options);
    const evidence: unknown[] = [];
    try {
      const origin = await app.listen({ host: '127.0.0.1', port: 0 });
      const base = `${origin}/api/v1`;
      const tokens: Record<string,string> = {};
      const call = async (who: string, method: string, path: string, body?: unknown) => {
        if (!tokens[who]) {
          const r = await fetch(`${base}/auth/login`, { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({username:who,password:'pw'}), signal: AbortSignal.timeout(10000) });
          tokens[who] = (await r.json() as any).access_token;
        }
        const r = await fetch(base + path, { method, headers: {authorization:`Bearer ${tokens[who]}`, 'content-type':'application/json'}, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
        const data: any = await r.json();
        evidence.push({method,path,http:r.status,data});
        return {status:r.status,data};
      };
      const chat = (await call('owner','POST','/chats',{chat_type:'group',name:'隔离授权群',member_ids:['reader']})).data.chat_id;
      await call('owner','POST','/chats',{chat_type:'group',name:'隔离未授权群',member_ids:['reader']});
      const doc = (await call('owner','POST','/docs',{title:'隔离批准文档',markdown:'不可发送的正文'})).data.doc_id;
      const privateDoc = (await call('reader','POST','/docs',{title:'隔离无权文档',markdown:'私密'})).data.doc_id;
      await call('reader','PUT',`/docs/${privateDoc}/permissions`,{link_share:'off',members:[]});
      expect((await call('owner','GET',`/docs/${privateDoc}`)).status).toBe(403);
      const task = (await call('owner','POST','/agent/triggers',{name:'隔离联测任务',event:'schedule',cron:'* * * * *',prompt:'不执行模型',enabled:false})).data.trigger_id;
      const draft = (await call('owner','POST','/automation/drafts',{taskKind:'trigger',taskId:task,
        recipients:{kind:'fixed',targets:[{type:'chat',id:chat},{type:'user',id:'recipient'}]},
        resources:[{type:'doc',resourceId:doc}],output:{mode:'protected_doc_link',docIds:[doc]},
        limits:{perRun:2,perDay:4,perTargetPerRun:1,perTargetPerDay:2,timezone:'Asia/Shanghai'},expiresAt:new Date(Date.now()+3600000).toISOString()})).data;
      expect((await call('owner','GET',`/automation/drafts/${draft.draftId}`)).status).toBe(200);
      const approved = await call('owner','POST',`/automation/drafts/${draft.draftId}/approve`,{expectedVersion:draft.version,expectedDigest:draft.draftDigest,enableTask:true});
      expect(approved.data.deliveryEnabled).toBe(true);
      const client = () => createTrustedScheduler({baseUrl:base,schedulerToken:token,botToken:'network-bot',stateDir});
      const occurrence = scheduleOccurrence('* * * * *',Date.now());
      const first = await client().execute(task,occurrence);
      expect(first.status).toBe('done');
      expect((await client().execute(task,occurrence)).status).toBe('done');
      // 独立的新周期；使用窗口内前一分钟，避免等待真实时钟推进。
      expect((await client().execute(task,scheduleOccurrence('* * * * *',Date.now()-60000))).status).toBe('done');
      const runs = (await call('owner','GET','/automation/runs')).data.items;
      expect(runs).toHaveLength(2);
      expect(runs.every((r:any)=>r.status==='succeeded' && r.deliveries.length===2)).toBe(true);
      const messages = (await call('reader','GET',`/chats/${chat}/messages`)).data.items.filter((m:any)=>m.sender_id==='bot');
      expect(messages).toHaveLength(2);
      expect(JSON.stringify(messages)).not.toContain('不可发送的正文');
      expect((await client().execute(task,scheduleOccurrence('* * * * *',Date.now()-120000))).status).toBe('blocked');
      await call('owner','POST',`/automation/drafts/${draft.draftId}/revoke`,{expectedVersion:approved.data.version});
      expect((await client().execute(task,scheduleOccurrence('* * * * *',Date.now()-180000))).status).toBe('blocked');
      const finalMessages = (await call('reader','GET',`/chats/${chat}/messages`)).data.items.filter((m:any)=>m.sender_id==='bot');
      expect(finalMessages).toHaveLength(2);
      evidence.push({first,runIds:runs.map((r:any)=>r.runId),groupMessageCount:finalMessages.length});
      const serialized = JSON.stringify(evidence,null,2);
      expect(serialized).not.toContain(token);
      expect(serialized).not.toContain('credentialHash');
      await writeFile(`_tmp/automation-network-${mode}.json`,serialized);
    } finally { await app.close(); await pool?.end(); await rm(stateDir,{recursive:true,force:true}); }
  },30000);
});
