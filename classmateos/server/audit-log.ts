/**
 * 操作日志（迭代 5 R-AD-04）。
 * 存通用对象表 kind=audit_log，scope=YYYY-MM（按月分区，查询时只读涉及的月份）。
 * 写日志失败不影响业务（只打印错误）。
 */
import { randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { Repo } from './repo.js';

export interface AuditEntry {
  log_id: string;
  created_at: string;
  operator_id: string | null;
  operator_name: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  target_name: string | null;
  detail: string | null;
  ip: string | null;
  device: string | null;
}

export interface AuditQuery {
  start_at?: string;
  end_at?: string;
  operator_id?: string;
  action?: string;
}

const KIND = 'audit_log';
const month = (iso: string) => iso.slice(0, 7);

export function requestMeta(req: FastifyRequest | undefined): { ip: string | null; device: string | null } {
  if (!req) return { ip: null, device: null };
  const b = (req.body ?? {}) as Record<string, unknown>;
  const h = req.headers['x-device-name'];
  const ua = req.headers['user-agent'];
  const device = (typeof b.device_name === 'string' && b.device_name.trim()) || (typeof h === 'string' && h) || (typeof ua === 'string' && ua) || null;
  return { ip: req.ip ?? null, device: device ? String(device).slice(0, 200) : null };
}

export class AuditLogService {
  constructor(private readonly repo: Repo) {}

  async record(e: Omit<AuditEntry, 'log_id' | 'created_at' | 'ip' | 'device'> & { req?: FastifyRequest; at?: string }): Promise<void> {
    const at = e.at ?? new Date().toISOString();
    const { req, ...rest } = e;
    const entry: AuditEntry = {
      log_id: `log_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      created_at: at,
      ...requestMeta(req),
      operator_id: rest.operator_id,
      operator_name: rest.operator_name,
      action: rest.action,
      target_type: rest.target_type ?? null,
      target_id: rest.target_id ?? null,
      target_name: rest.target_name ?? null,
      detail: rest.detail ? String(rest.detail).slice(0, 2000) : null,
    };
    try {
      await this.repo.saveEntity({ kind: KIND, id: entry.log_id, scope: month(at), data: { ...entry }, version: 0, created_at: at, updated_at: at }, 0);
    } catch (err) {
      console.error('[audit] write failed', err);
    }
  }

  /** 按时间倒序返回全部匹配项（调用方分页）。 */
  async query(q: AuditQuery): Promise<AuditEntry[]> {
    const start = q.start_at ? Date.parse(q.start_at) : NaN;
    const end = q.end_at ? Date.parse(q.end_at) : NaN;
    let rows: AuditEntry[];
    if (Number.isFinite(start)) {
      const months: string[] = [];
      const stop = Number.isFinite(end) ? new Date(end) : new Date();
      const d = new Date(Date.UTC(new Date(start).getUTCFullYear(), new Date(start).getUTCMonth(), 1));
      while (d <= stop && months.length < 240) {
        months.push(d.toISOString().slice(0, 7));
        d.setUTCMonth(d.getUTCMonth() + 1);
      }
      rows = [];
      for (const m of months) rows.push(...(await this.repo.listEntities(KIND, m)).map((r) => r.data as unknown as AuditEntry));
    } else {
      rows = (await this.repo.listEntities(KIND)).map((r) => r.data as unknown as AuditEntry);
    }
    return rows
      .filter((e) => {
        const t = Date.parse(e.created_at);
        if (Number.isFinite(start) && t < start) return false;
        if (Number.isFinite(end) && t >= end) return false;
        if (q.operator_id && e.operator_id !== q.operator_id) return false;
        if (q.action && e.action !== q.action) return false;
        return true;
      })
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.log_id.localeCompare(a.log_id));
  }
}

const csvCell = (v: unknown) => {
  let s = v == null ? '' : String(v);
  // 防 CSV 公式注入（Excel 打开时以 = + - @ 开头会被当公式）
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function auditCsv(items: AuditEntry[]): Buffer {
  const head = ['时间', '操作人', '操作人ID', '动作', '对象类型', '对象ID', '对象名称', '详情', 'IP', '设备'];
  const lines = [head.join(',')];
  for (const e of items) {
    lines.push([e.created_at, e.operator_name, e.operator_id, e.action, e.target_type, e.target_id, e.target_name, e.detail, e.ip, e.device].map(csvCell).join(','));
  }
  // 带 BOM，Excel 直接打开中文不乱码
  return Buffer.from('\uFEFF' + lines.join('\r\n') + '\r\n', 'utf8');
}
