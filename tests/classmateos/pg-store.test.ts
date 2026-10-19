/**
 * PgTableStore 测试：fake pool 捕获 SQL + 返回罐装行。
 * 本机无 PG 实例（CI 可接 testcontainers 后换真库重跑同一接口）。
 */

import { describe, expect, it } from 'vitest';
import { PgTableStore, type PgPoolLike } from '../../classmateos/server/pg-store.js';

interface CapturedQuery {
  text: string;
  params: unknown[];
}

function fakePool(handler?: (q: CapturedQuery) => Array<Record<string, unknown>>) {
  const queries: CapturedQuery[] = [];
  const pool: PgPoolLike = {
    async query(text, params = []) {
      const q = { text, params };
      queries.push(q);
      return { rows: handler?.(q) ?? [] };
    },
  };
  return { pool, queries };
}

const NOW = new Date('2026-10-19T08:00:00Z');

describe('PgTableStore', () => {
  it('create：动态列 INSERT，DateTime ms→ISO、User 字段 JSON 序列化', async () => {
    const { pool, queries } = fakePool(() => [
      {
        record_id: 'rec_x',
        milestone: 'M1',
        status: '进行中',
        due_date: NOW,
        owner_open_id: [{ id: 'ou_1' }],
        created_at: NOW,
        updated_at: NOW,
      },
    ]);
    const store = new PgTableStore(pool);
    const dueMs = NOW.getTime();

    const rec = await store.create('gantt', {
      milestone: 'M1',
      status: '进行中',
      due_date: dueMs,
      owner_open_id: [{ id: 'ou_1' }],
    });

    const q0 = queries[0];
    expect(q0.text).toMatch(/^INSERT INTO "gantt" \("record_id", "milestone", "status", "due_date", "owner_open_id"\)/);
    expect(q0.text).toContain('VALUES ($1, $2, $3, $4, $5) RETURNING *');
    expect(q0.params[1]).toBe('M1');
    expect(q0.params[3]).toBe(NOW.toISOString()); // ms → ISO
    expect(q0.params[4]).toBe('[{"id":"ou_1"}]'); // jsonb 序列化

    // 回读方向：timestamptz → ms、jsonb → 对象
    expect(rec.fields.due_date).toBe(dueMs);
    expect(rec.fields.owner_open_id).toEqual([{ id: 'ou_1' }]);
  });

  it('list：filter 翻译成参数化 WHERE，sort + LIMIT/OFFSET 分页', async () => {
    const { pool, queries } = fakePool(() => [
      { record_id: 'r1', fields: null, title: 'A', created_at: NOW, updated_at: NOW },
      { record_id: 'r2', title: 'B', created_at: NOW, updated_at: NOW },
      { record_id: 'r3', title: 'C', created_at: NOW, updated_at: NOW }, // pageSize+1 → hasMore
    ]);
    const store = new PgTableStore(pool);
    const res = await store.list('gantt', {
      filter: 'status="进行中" AND progress<80',
      sort: 'due_date desc',
      pageSize: 2,
      pageToken: '4',
    });

    const q0 = queries[0];
    expect(q0.text).toBe(
      'SELECT *, count(*) OVER() AS __total FROM "gantt" WHERE "status"::text = $1 AND "progress" < $2::double precision ORDER BY "due_date" DESC LIMIT $3 OFFSET $4',
    );
    expect(q0.params).toEqual(['进行中', '80', 3, 4]);

    expect(res.items).toHaveLength(2);
    expect(res.has_more).toBe(true);
    expect(res.page_token).toBe('6');
    // null 字段不进 fields
    expect(res.items[0].fields).toEqual({ title: 'A' });
  });

  it('update/delete/非法 filter', async () => {
    const { pool, queries } = fakePool((q) =>
      q.text.startsWith('UPDATE')
        ? [{ record_id: 'rec_1', status: '完成', created_at: NOW, updated_at: NOW }]
        : [{ record_id: 'rec_1' }],
    );
    const store = new PgTableStore(pool);

    const updated = await store.update('projects', 'rec_1', { status: '完成' });
    expect(queries[0].text).toBe(
      'UPDATE "projects" SET "status" = $1, updated_at = now() WHERE record_id = $2 RETURNING *',
    );
    expect(updated?.fields.status).toBe('完成');

    expect(await store.delete('projects', 'rec_1')).toBe(true);
    expect(queries[1].text).toContain('DELETE FROM "projects"');

    await expect(store.list('projects', { filter: 'progress ~ 5' })).rejects.toThrow(
      /unparseable filter/,
    );
  });
});
