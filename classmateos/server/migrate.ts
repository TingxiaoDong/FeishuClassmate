/**
 * 数据迁移（PLAN §2.5 / §3-P4）：飞书 Bitable → ClassmateOS 表格引擎。
 *
 * 流程：FeishuClient.listRecords 读源表 → PAL TableService.createRecord 写目标。
 * 五张核心表优先：projects / gantt / equipment / research / tool_trace，
 * 其余表传 tableKeys 追加即可。
 *
 * 设计要点：
 *   - 可注入 reader/writer —— 测试无需真飞书凭证或真 server；
 *   - --dry-run 只统计不写；
 *   - 幂等依据：源 record_id 写入目标字段 `feishu_record_id`（目标表 DDL 有
 *     冗余 jsonb 承载能力，P4 灰度期用于对账与去重）；
 *   - 单条失败不中断整表，最后汇总报告。
 */

import type { ClassmateConfig } from '../../src/config.js';
import type { Result } from '../../src/util/feishu-api.js';
import type { TableService } from '../../src/pal/types.js';

export const CORE_TABLES = ['projects', 'gantt', 'equipment', 'research', 'tool_trace'] as const;

/** FeishuClient.listRecords 的最小结构等价物（便于注入 fake）。 */
export interface BitableReader {
  listRecords(
    appToken: string,
    tableId: string,
    opts?: { pageSize?: number },
  ): Promise<Result<Array<{ record_id: string; fields: Record<string, unknown> }>>>;
}

export interface MigrateOptions {
  config: ClassmateConfig;
  reader: BitableReader;
  writer: TableService;
  tableKeys?: string[];
  dryRun?: boolean;
  batchSize?: number;
  onLog?: (msg: string) => void;
}

export interface TableReport {
  tableKey: string;
  sourceCount: number;
  migrated: number;
  failed: number;
  skipped: boolean;
  errors: string[];
}

export async function migrateTables(opts: MigrateOptions): Promise<TableReport[]> {
  const log = opts.onLog ?? (() => {});
  const tableKeys = opts.tableKeys ?? [...CORE_TABLES];
  const reports: TableReport[] = [];

  for (const key of tableKeys) {
    const report: TableReport = {
      tableKey: key,
      sourceCount: 0,
      migrated: 0,
      failed: 0,
      skipped: false,
      errors: [],
    };
    reports.push(report);

    const tableId = opts.config.bitable.tableIds?.[key as keyof ClassmateConfig['bitable']['tableIds']];
    if (!tableId) {
      report.skipped = true;
      report.errors.push('tableId 未配置，跳过');
      log(`[migrate/${key}] skipped: tableId not configured`);
      continue;
    }

    const res = await opts.reader.listRecords(opts.config.bitable.appToken, tableId, {
      pageSize: 500,
    });
    if (!res.ok) {
      report.skipped = true;
      report.errors.push(`读取源表失败: ${res.error}`);
      log(`[migrate/${key}] read failed: ${res.error}`);
      continue;
    }

    report.sourceCount = res.value.length;
    log(`[migrate/${key}] ${res.value.length} records to migrate${opts.dryRun ? ' (dry-run)' : ''}`);
    if (opts.dryRun) continue;

    for (const rec of res.value) {
      const fields = { ...rec.fields, feishu_record_id: rec.record_id };
      const w = await opts.writer.createRecord(key, fields);
      if (w.ok) {
        report.migrated += 1;
      } else {
        report.failed += 1;
        report.errors.push(`${rec.record_id}: ${w.error}`);
        log(`[migrate/${key}] FAILED ${rec.record_id}: ${w.error}`);
      }
    }
    log(`[migrate/${key}] done: ${report.migrated} ok, ${report.failed} failed`);
  }

  return reports;
}

/** 汇总报告为纯文本（CLI 输出 / 迁移记录归档用）。 */
export function formatReport(reports: TableReport[]): string {
  const lines = reports.map((r) => {
    if (r.skipped) return `${r.tableKey}: SKIPPED (${r.errors[0] ?? ''})`;
    return `${r.tableKey}: ${r.migrated}/${r.sourceCount} migrated, ${r.failed} failed`;
  });
  const totalOk = reports.reduce((s, r) => s + r.migrated, 0);
  const totalFail = reports.reduce((s, r) => s + r.failed, 0);
  return [...lines, `TOTAL: ${totalOk} migrated, ${totalFail} failed`].join('\n');
}
