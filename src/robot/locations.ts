/**
 * 机器人地点表（AGENT_PLAN M4 §3.3）。替代 temi.py 里写死的厨房 / 沙发映射。
 *
 * 真实来源是平台的 RobotLocations（GET /bot/robots/:id/locations），这里带缓存；
 * 平台不可用时用 CLASSMATE_ROBOT_LOCATIONS（JSON）或内置的默认地点。
 * 地点表同时就是「白名单」：不在表里、或被停用（allowed=false）的地点，机器人不去。
 */

import type { CosClient } from '../cos-sdk/client.js';

export type LocationKind = 'room' | 'workstation' | 'dock' | 'other';

export interface RobotLocation {
  /** Temi 地图上保存的名字（发给机器人的就是它）。 */
  name: string;
  /** 给同学看的名字，如「302 会议室」。 */
  label: string;
  aliases: string[];
  kind: LocationKind;
  /** 工位：属于哪位同学（deliver_message / find_person 用）。 */
  owner_user_id?: string | null;
  /** 是否允许机器人前往（白名单开关）。 */
  allowed: boolean;
}

export const DEFAULT_LOCATIONS: RobotLocation[] = [
  { name: '入口', label: '入口', aliases: ['门口', '前台', '大门', 'entrance'], kind: 'room', allowed: true },
  { name: '充电桩', label: '充电桩', aliases: ['回充', '充电', 'home base', 'home'], kind: 'dock', allowed: true },
  { name: '工位区', label: '工位区', aliases: ['工位'], kind: 'room', allowed: true },
  { name: '生活仿真区', label: '生活仿真区', aliases: ['仿真区'], kind: 'room', allowed: true },
];

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, '');

export function normalizeLocation(raw: Partial<RobotLocation> & { name: string }): RobotLocation {
  return {
    name: raw.name,
    label: raw.label || raw.name,
    aliases: Array.isArray(raw.aliases) ? raw.aliases.filter((a) => typeof a === 'string') : [],
    kind: (['room', 'workstation', 'dock', 'other'] as const).includes(raw.kind as LocationKind) ? (raw.kind as LocationKind) : 'other',
    owner_user_id: raw.owner_user_id ?? null,
    allowed: raw.allowed !== false,
  };
}

/** 按名字 / 显示名 / 别名找地点；精确优先，其次唯一的包含匹配。 */
export function matchLocation(list: RobotLocation[], query: string): RobotLocation | undefined {
  const q = norm(query);
  if (!q) return undefined;
  const keys = (l: RobotLocation) => [l.name, l.label, ...l.aliases].map(norm);
  const exact = list.find((l) => keys(l).includes(q));
  if (exact) return exact;
  const partial = list.filter((l) => keys(l).some((k) => k && (k.includes(q) || q.includes(k))));
  return partial.length === 1 ? partial[0] : undefined;
}

export interface LocationRegistry {
  list(): Promise<RobotLocation[]>;
  resolve(query: string): Promise<RobotLocation | undefined>;
  /** 某位同学的工位。 */
  workstationOf(userId: string): Promise<RobotLocation | undefined>;
  /** 平台上改了地点后清缓存。 */
  invalidate(): void;
}

export class StaticLocationRegistry implements LocationRegistry {
  constructor(private items: RobotLocation[] = DEFAULT_LOCATIONS) {}
  async list() {
    return this.items;
  }
  async resolve(q: string) {
    return matchLocation(this.items, q);
  }
  async workstationOf(userId: string) {
    return this.items.find((l) => l.kind === 'workstation' && l.owner_user_id === userId);
  }
  invalidate() {}
}

/** 从环境变量读地点（JSON 数组），读不出来用默认。 */
export function locationsFromEnv(env: NodeJS.ProcessEnv = process.env): RobotLocation[] {
  const raw = env.CLASSMATE_ROBOT_LOCATIONS;
  if (!raw) return DEFAULT_LOCATIONS;
  try {
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) return DEFAULT_LOCATIONS;
    const items = arr
      .map((x) => (typeof x === 'string' ? { name: x } : x))
      .filter((x): x is { name: string } => !!x && typeof (x as { name?: unknown }).name === 'string')
      .map(normalizeLocation);
    return items.length ? items : DEFAULT_LOCATIONS;
  } catch {
    return DEFAULT_LOCATIONS;
  }
}

/** 平台地点表 + 缓存；平台出错时用上一次的结果，从没成功过就用 fallback。 */
export class CosLocationRegistry implements LocationRegistry {
  private cache?: { at: number; items: RobotLocation[] };

  constructor(
    private client: CosClient,
    private robotId = 'temi',
    private opts: { ttlMs?: number; fallback?: RobotLocation[]; onError?: (e: unknown) => void } = {},
  ) {}

  async list(): Promise<RobotLocation[]> {
    const ttl = this.opts.ttlMs ?? 60_000;
    if (this.cache && Date.now() - this.cache.at < ttl) return this.cache.items;
    const r = await this.client.get<{ items: Array<Partial<RobotLocation> & { name: string }> }>(`/bot/robots/${encodeURIComponent(this.robotId)}/locations`, { asBot: true });
    if (r.ok && Array.isArray(r.data.items)) {
      const items = r.data.items.map(normalizeLocation);
      // 平台上还没建过地点：沿用默认，免得机器人哪儿都去不了
      this.cache = { at: Date.now(), items };
      return this.cache.items;
    }
    this.opts.onError?.(new Error(`robot locations: ${r.ok ? 'bad shape' : r.error}`));
    return []; // 平台不可用时关闭导航，不使用过期白名单
  }

  async resolve(q: string) {
    return matchLocation(await this.list(), q);
  }

  async workstationOf(userId: string) {
    return (await this.list()).find((l) => l.kind === 'workstation' && l.owner_user_id === userId);
  }

  invalidate() {
    this.cache = undefined;
  }
}
