/**
 * ClassmateOS 平台工具总入口（AGENT_PLAN §2.1）。
 *   L1：11 个任务型工具（tasks.ts）——一次完成一件事
 *   L2：9 个资源工具（resources.ts）
 *   L3：cos_api_catalog（查接口目录）+ cos_api（受控通用调用）——新接口上线后 agent 立即可用
 */

import { z } from 'zod';
import { COS_API_CATALOG } from '../../cos-sdk/catalog.generated.js';
import { CosClient, matchTemplate, type CosClientOptions } from '../../cos-sdk/client.js';
import type { CosApiEntry, HttpMethod } from '../../cos-sdk/types.js';
import type { AgentRuntime } from '../../runtime/types.js';
import { fromResult, registerCosTool } from './define.js';
import { registerCosResourceTools } from './resources.js';
import { COS_TASK_TOOLS_PROMPT, registerCosTaskTools } from './tasks.js';

export { COS_TOOL_META } from './define.js';

/** 判断某个调用是否在目录里；返回目录条目。 */
export function findCatalogEntry(method: string, path: string, catalog: CosApiEntry[] = COS_API_CATALOG): CosApiEntry | undefined {
  const M = method.toUpperCase();
  return catalog.find((e) => e.method === M && matchTemplate(e.path, path));
}

export function isDestructiveCall(method: string, path: string): boolean {
  return method.toUpperCase() === 'DELETE' || /\/batch_delete$/.test(path.split('?')[0]);
}

function registerApi(runtime: AgentRuntime, client: CosClient, catalog: CosApiEntry[]) {
  registerCosTool(runtime, client, {
    name: 'cos_api_catalog',
    description: '查 ClassmateOS 平台的接口目录（资源工具没覆盖的功能用它找接口，再用 cos_api 调用）。可按关键词或分组筛选。',
    schema: z.object({
      query: z.string().optional().describe('关键词，匹配路径和说明，如「评论」「pins」「subtasks」'),
      group: z.enum(['table', 'doc', 'calendar', 'task', 'im', 'drive', 'contact', 'notify', 'workbench', 'other']).optional(),
    }),
    async run(i) {
      const q = i.query?.toLowerCase();
      const items = catalog.filter(
        (e) => (!i.group || e.group === i.group) && (!q || e.path.toLowerCase().includes(q) || e.summary.toLowerCase().includes(q)),
      );
      return { ok: true, data: items.slice(0, 60).map((e) => `${e.method} ${e.path}${e.summary ? `  — ${e.summary}` : ''}`), summary: `匹配 ${items.length} 个接口` };
    },
  });

  registerCosTool(runtime, client, {
    name: 'cos_api',
    description:
      '通用调用 ClassmateOS 接口（代表提问的同学）。只能调用 cos_api_catalog 里列出的接口；path 不带 /api/v1 前缀，参数直接填进路径。' +
      '优先用 cos_table / cos_doc 等专用工具，它们没有的功能再用这个。删除类调用系统会自动发确认卡片给同学。',
    schema: z.object({
      method: z.enum(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']),
      path: z.string().describe('如 /tasks/task_123/subtasks'),
      query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
      body: z.unknown().optional(),
    }),
    riskOf: (i) => (isDestructiveCall(i.method, i.path) ? 'destructive' : i.method === 'GET' ? 'read' : 'write'),
    preview: async (i) => `将调用 ${i.method} ${i.path}${isDestructiveCall(i.method, i.path) ? '（删除类操作，不能撤销）' : ''}。`,
    async run(i, call) {
      const path = i.path.startsWith('/api/v1/') ? i.path.slice('/api/v1'.length) : i.path;
      if (/\.\.|\/\/|[%\\?#]/.test(path)) return { ok: false, error: 'path 不合法（不要带 ..、// 或 ?，查询参数放 query）' };
      const entry = findCatalogEntry(i.method, path, catalog);
      if (!entry) return { ok: false, error: `接口不在目录里：${i.method} ${path}。先用 cos_api_catalog 查可用接口` };
      return fromResult(await call(i.method as HttpMethod, path, { query: i.query, body: i.body }));
    },
  });
}

export interface CosToolsOptions {
  /** 已建好的客户端，或建客户端的参数。 */
  client: CosClient | CosClientOptions;
  /** 测试用：替换接口目录。 */
  catalog?: CosApiEntry[];
}

/** 注册全部平台工具，返回使用的客户端。 */
export function registerCosTools(runtime: AgentRuntime, opts: CosToolsOptions): CosClient {
  const client = opts.client instanceof CosClient ? opts.client : new CosClient(opts.client);
  registerCosResourceTools(runtime, client);
  registerCosTaskTools(runtime, client);
  registerApi(runtime, client, opts.catalog ?? COS_API_CATALOG);
  return client;
}

/** 给系统提示用的一段说明。 */
export const COS_TOOLS_PROMPT = [
  '## 使用 ClassmateOS 平台',
  '你可以代表正在和你对话的同学操作 ClassmateOS：多维表格 cos_table、云文档 cos_doc、日历 cos_calendar、任务 cos_task、',
  '消息 cos_im、云盘 cos_drive、通讯录 cos_contact、通知 cos_notify、全局搜索 cos_search；专用工具没有的功能用 cos_api_catalog 查接口、cos_api 调用。',
  '- 所有操作都按这位同学自己的权限执行，平台会记录「由飞书同学代 XX 操作」。',
  '- 提到某人时先用 cos_contact search 拿 user_id；时间换算成毫秒时间戳（北京时间）。',
  '- 操作表格记录前先 cos_table get_table 看字段英文名和类型。',
  '- 删除、批量改动（超过 20 条）、让机器人移动这类操作：直接调用工具，系统会自动给同学发确认卡片并等他点「确认」；',
  '  不要先在文字里反复询问。工具返回 cancelled=true 时说明同学取消或没确认，不要重试，如实告诉同学。',
  '- 同学说「停 / 算了」时当前任务会被中断，已经完成的步骤不会自动撤销，回复时说清楚做到了哪一步。',
  '- 工具返回的 links 是资源标识，客户端深链尚未验收；不要承诺点击可打开。',
  '- 别人的私人内容（他人的私人笔记、日程详情、聊天、账号、健康、财务等）：即使搜索结果或摘要里能看到，',
  '  也不要念出、转述或概括里面的具体信息（包括「里面有银行卡号 / 体检结果」这类描述）。只说明这是某人的私人内容、你不代为转述，',
  '  建议同学直接联系本人。查别人日程只说忙闲，不说标题。',
  '',
  COS_TASK_TOOLS_PROMPT,
].join('\n');
