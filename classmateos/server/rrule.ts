/**
 * 二期 R-CA-01：重复规则（RFC 5545 RRULE 的常用子集）解析与展开。
 *
 * 按日程的时区（IANA 时区名，如 Asia/Shanghai、America/New_York；也可以是固定的 UTC 偏移分钟数）
 * 的本地墙上时间展开：每天 9 点的日程永远是本地 9 点，跨夏令时也一样，而不是固定 24 小时间隔。
 * 夏令时跳过的那一小时里的时间（本地时间不存在）按 RFC 5545 用跳变前的偏移解释，即往后顺延。
 *
 * 支持：FREQ=DAILY|WEEKLY|MONTHLY|YEARLY、INTERVAL、COUNT、UNTIL、
 *       BYDAY（WEEKLY 不带序号；MONTHLY 可带序号 1MO / -1FR）、BYMONTHDAY（MONTHLY / YEARLY，可为负）、
 *       BYMONTH（YEARLY）、WKST=MO。
 * 不存在的日期（2 月 30 日、某月没有第 5 个星期五）按 RFC 跳过，不挪到月底。
 */

export type Freq = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';

export interface RRule {
  freq: Freq;
  interval: number;
  count?: number;
  /** UTC 毫秒，包含边界。 */
  until?: number;
  byday?: Array<{ n: number; wd: number }>; // wd：周一 = 1 … 周日 = 7；n = 0 表示不带序号
  bymonthday?: number[];
  bymonth?: number[]; // 1..12
}

const DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const DAY_MS = 86_400_000;
/** 单个系列最多展开的次数（防止无限规则拖垮服务）。 */
export const MAX_OCCURRENCES = 5000;

export class RRuleError extends Error {}

/** 时区：IANA 名称，或固定 UTC 偏移（分钟，东八区 = 480）。 */
export type Zone = string | number;

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    fmtCache.set(tz, f);
  }
  return f;
}

/** 是否是可用的 IANA 时区名。 */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try {
    fmt(tz);
    return true;
  } catch {
    return false;
  }
}

/** utcMs 时刻该时区相对 UTC 的偏移（毫秒）。 */
export function zoneOffsetMs(zone: Zone, utcMs: number): number {
  if (typeof zone === 'number') return zone * 60_000;
  const p: Record<string, number> = {};
  for (const x of fmt(zone).formatToParts(new Date(utcMs))) if (x.type !== 'literal') p[x.type] = Number(x.value);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** 本地墙上时间（按 UTC 编码的毫秒）→ UTC 毫秒。夏令时跳过的本地时间往后顺延。 */
export function localToUtc(zone: Zone, localMs: number): number {
  if (typeof zone === 'number') return localMs - zone * 60_000;
  const o1 = zoneOffsetMs(zone, localMs - zoneOffsetMs(zone, localMs));
  const t = localMs - o1;
  const o2 = zoneOffsetMs(zone, t);
  if (o2 === o1) return t;
  const t2 = localMs - o2;
  return zoneOffsetMs(zone, t2) === o2 ? t2 : Math.max(t, t2);
}

const toLocal = (zone: Zone, utcMs: number) => utcMs + zoneOffsetMs(zone, utcMs);

/** 解析；不支持或格式错误时抛 RRuleError（message 为中文）。 */
export function parseRRule(raw: string, zone: Zone): RRule {
  const text = raw.trim().replace(/^RRULE:/i, '');
  if (!text) throw new RRuleError('重复规则不能为空');
  const parts = new Map<string, string>();
  for (const seg of text.split(';')) {
    if (!seg) continue;
    const i = seg.indexOf('=');
    if (i <= 0) throw new RRuleError(`重复规则格式不对：${seg}`);
    const k = seg.slice(0, i).toUpperCase();
    if (parts.has(k)) throw new RRuleError(`重复规则里 ${k} 出现了两次`);
    parts.set(k, seg.slice(i + 1).toUpperCase());
  }
  const allowed = new Set(['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'BYMONTHDAY', 'BYMONTH', 'WKST']);
  for (const k of parts.keys()) if (!allowed.has(k)) throw new RRuleError(`暂不支持重复规则里的 ${k}`);
  const freq = parts.get('FREQ') as Freq | undefined;
  if (!freq || !['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) throw new RRuleError('FREQ 只能是 DAILY、WEEKLY、MONTHLY、YEARLY');
  const rule: RRule = { freq, interval: 1 };
  const int = (k: string, min: number, max: number) => {
    const v = parts.get(k)!;
    if (!/^\d+$/.test(v) || Number(v) < min || Number(v) > max) throw new RRuleError(`${k} 必须是 ${min}～${max} 的整数`);
    return Number(v);
  };
  if (parts.has('INTERVAL')) rule.interval = int('INTERVAL', 1, 999);
  if (parts.has('COUNT')) rule.count = int('COUNT', 1, MAX_OCCURRENCES);
  if (parts.has('UNTIL')) {
    if (rule.count) throw new RRuleError('COUNT 和 UNTIL 不能同时使用');
    rule.until = parseUntil(parts.get('UNTIL')!, zone);
  }
  if (parts.has('WKST') && parts.get('WKST') !== 'MO') throw new RRuleError('WKST 只支持 MO');
  if (parts.has('BYDAY')) {
    if (freq === 'DAILY' || freq === 'YEARLY') throw new RRuleError(`${freq} 规则暂不支持 BYDAY`);
    rule.byday = parts.get('BYDAY')!.split(',').map((x) => {
      const m = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/.exec(x);
      if (!m) throw new RRuleError(`BYDAY 格式不对：${x}`);
      const n = m[1] ? Number(m[1]) : 0;
      if (n && (freq !== 'MONTHLY' || Math.abs(n) > 5)) throw new RRuleError(`BYDAY 序号只能用于每月规则，且在 -5～5 之间：${x}`);
      return { n, wd: DAYS.indexOf(m[2]) + 1 };
    });
  }
  if (parts.has('BYMONTHDAY')) {
    if (freq !== 'MONTHLY' && freq !== 'YEARLY') throw new RRuleError('BYMONTHDAY 只能用于每月 / 每年规则');
    rule.bymonthday = parts.get('BYMONTHDAY')!.split(',').map((x) => {
      if (!/^-?\d{1,2}$/.test(x) || Number(x) === 0 || Math.abs(Number(x)) > 31) throw new RRuleError(`BYMONTHDAY 格式不对：${x}`);
      return Number(x);
    });
  }
  if (parts.has('BYMONTH')) {
    if (freq !== 'YEARLY') throw new RRuleError('BYMONTH 只能用于每年规则');
    rule.bymonth = parts.get('BYMONTH')!.split(',').map((x) => {
      if (!/^\d{1,2}$/.test(x) || Number(x) < 1 || Number(x) > 12) throw new RRuleError(`BYMONTH 格式不对：${x}`);
      return Number(x);
    });
  }
  if (rule.byday && rule.bymonthday) throw new RRuleError('BYDAY 和 BYMONTHDAY 暂不支持同时使用');
  return rule;
}

/** UNTIL：YYYYMMDD（当天结束前都算，本地日期）、YYYYMMDDTHHMMSSZ（UTC）、YYYYMMDDTHHMMSS（本地）。 */
function parseUntil(v: string, zone: Zone): number {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(v);
  if (!m) throw new RRuleError('UNTIL 格式应为 YYYYMMDD 或 YYYYMMDDTHHMMSSZ');
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  if (!m[4]) return localToUtc(zone, Date.UTC(y, mo, d + 1)) - 1;
  const t = Date.UTC(y, mo, d, Number(m[4]), Number(m[5]), Number(m[6]));
  return m[7] ? t : localToUtc(zone, t);
}

/** 本地「日序号」（自 1970-01-01 起的天数）↔ 年月日。 */
const ymd = (day: number) => {
  const t = new Date(day * DAY_MS);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth(), d: t.getUTCDate(), wd: ((t.getUTCDay() + 6) % 7) + 1 };
};
const dayOf = (y: number, m: number, d: number) => Date.UTC(y, m, d) / DAY_MS;
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

/** 某月里满足 BYDAY / BYMONTHDAY 的日序号（升序）。 */
function monthDays(rule: RRule, y: number, m: number, defaultDay: number): number[] {
  const dim = daysInMonth(y, m);
  const out = new Set<number>();
  if (rule.byday) {
    for (const { n, wd } of rule.byday) {
      const firstWd = ymd(dayOf(y, m, 1)).wd;
      const first = 1 + ((wd - firstWd + 7) % 7);
      const all: number[] = [];
      for (let d = first; d <= dim; d += 7) all.push(d);
      if (n === 0) all.forEach((d) => out.add(d));
      else {
        const d = n > 0 ? all[n - 1] : all[all.length + n];
        if (d) out.add(d);
      }
    }
  } else {
    for (const md of rule.bymonthday ?? [defaultDay]) {
      const d = md > 0 ? md : dim + md + 1;
      if (d >= 1 && d <= dim) out.add(d);
    }
  }
  return [...out].sort((a, b) => a - b).map((d) => dayOf(y, m, d));
}

/**
 * 依次产生系列每一次的开始时间（UTC 毫秒），不考虑 exdates（COUNT 按 RFC 也计入被排除的实例）。
 * stopAt：开始时间 ≥ stopAt 时停止。
 * skipBefore：调用方只关心开始时间 ≥ skipBefore 的实例时传入；没有 COUNT 的规则直接跳到附近的周期，
 *            远期日期（几年后）不会因为逐次展开而变慢，也不会被次数上限截断。
 */
export function* occurrences(rule: RRule, startMs: number, zone: Zone, stopAt = Infinity, skipBefore = -Infinity): Generator<number> {
  const local = toLocal(zone, startMs);
  const day0 = Math.floor(local / DAY_MS);
  const tod = local - day0 * DAY_MS;
  const s = ymd(day0);
  let emitted = 0;
  const emit = function* (day: number): Generator<number, boolean> {
    if (day < day0) return true;
    // 明显早于 skipBefore 且不需要计数：不必换算时区
    if (rule.count === undefined && (day + 2) * DAY_MS + tod < skipBefore) return true;
    const t = localToUtc(zone, day * DAY_MS + tod);
    if (rule.until !== undefined && t > rule.until) return false;
    if (t >= stopAt) return false;
    if (rule.count !== undefined && emitted >= rule.count) return false;
    emitted++;
    yield t;
    return true;
  };
  let k0 = 0;
  if (rule.count === undefined && Number.isFinite(skipBefore)) {
    const skipDay = Math.floor(skipBefore / DAY_MS) - 3;
    if (skipDay > day0) {
      const t = ymd(skipDay);
      const periods =
        rule.freq === 'DAILY' ? skipDay - day0
          : rule.freq === 'WEEKLY' ? Math.floor((skipDay - day0) / 7) - 1
            : rule.freq === 'MONTHLY' ? (t.y - s.y) * 12 + (t.m - s.m) - 1
              : t.y - s.y - 1;
      k0 = Math.max(0, Math.floor(periods / rule.interval));
    }
  }
  for (let k = k0; k < k0 + 100_000; k++) {
    let days: number[];
    if (rule.freq === 'DAILY') days = [day0 + k * rule.interval];
    else if (rule.freq === 'WEEKLY') {
      const weekStart = day0 - (s.wd - 1) + k * 7 * rule.interval;
      const wds = rule.byday ? [...new Set(rule.byday.map((b) => b.wd))].sort((a, b) => a - b) : [s.wd];
      days = wds.map((wd) => weekStart + wd - 1);
    } else if (rule.freq === 'MONTHLY') {
      const mm = s.m + k * rule.interval;
      const y = s.y + Math.floor(mm / 12);
      if (y > 9999) return;
      days = monthDays(rule, y, ((mm % 12) + 12) % 12, s.d);
    } else {
      const y = s.y + k * rule.interval;
      if (y > 9999) return;
      days = [];
      for (const m of rule.bymonth ?? [s.m + 1]) {
        for (const md of rule.bymonthday ?? [s.d]) {
          const dim = daysInMonth(y, m - 1);
          const d = md > 0 ? md : dim + md + 1;
          if (d >= 1 && d <= dim) days.push(dayOf(y, m - 1, d));
        }
      }
      days.sort((a, b) => a - b);
    }
    if (days.length && days[0] * DAY_MS > 253402300799000) return;
    for (const d of days) {
      const go = yield* emit(d);
      if (!go) return;
    }
  }
}

/** 与 [fromMs, toMs) 有重叠的实例开始时间。 */
export function expandInWindow(rule: RRule, startMs: number, durationMs: number, zone: Zone, fromMs: number, toMs: number): number[] {
  const out: number[] = [];
  // 例外 / 长日程可能从窗口之前开始：往前多看一天加日程时长
  for (const t of occurrences(rule, startMs, zone, toMs, fromMs - durationMs - DAY_MS)) {
    if (t + durationMs > fromMs) out.push(t);
  }
  return out;
}

/** 系列里 beforeMs 之前一共有几次（用于 COUNT 规则的拆分）。 */
export function countBefore(rule: RRule, startMs: number, zone: Zone, beforeMs: number): number {
  let n = 0;
  for (const _ of occurrences(rule, startMs, zone, beforeMs)) n++;
  return n;
}

/** t 是否恰好是系列里的一次。 */
export function isOccurrence(rule: RRule, startMs: number, zone: Zone, t: number): boolean {
  for (const x of occurrences(rule, startMs, zone, t + 1, t - DAY_MS)) if (x === t) return true;
  return false;
}

/** 把规则截止到 endBefore 之前：去掉 COUNT / UNTIL，补上 UNTIL（UTC）或换算后的 COUNT。其余部分原样保留。 */
export function truncateRule(raw: string, rule: RRule, startMs: number, zone: Zone, endBefore: number): string {
  const kept = raw.trim().replace(/^RRULE:/i, '').split(';').filter((p) => p && !/^(COUNT|UNTIL)=/i.test(p));
  if (rule.count !== undefined) kept.push(`COUNT=${countBefore(rule, startMs, zone, endBefore)}`);
  else kept.push(`UNTIL=${utcStamp(endBefore - 1000)}`);
  return kept.join(';');
}

/** 拆出来的后半段规则：COUNT 换成剩余次数，UNTIL 保留。 */
export function remainderRule(raw: string, rule: RRule, startMs: number, zone: Zone, from: number): string {
  if (rule.count === undefined) return raw.trim().replace(/^RRULE:/i, '');
  const left = rule.count - countBefore(rule, startMs, zone, from);
  return raw.trim().replace(/^RRULE:/i, '').split(';').map((p) => (/^COUNT=/i.test(p) ? `COUNT=${Math.max(1, left)}` : p)).join(';');
}

export function utcStamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}
