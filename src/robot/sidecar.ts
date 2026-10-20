/**
 * Temi sidecar 客户端（AGENT_PLAN M4 §3.1）。
 *
 * 大脑只通过这个接口和机器人打交道：
 *   - HttpSidecar：真机 / 本机 sidecar（temi-sidecar/server.py，HTTP + /events/ws 事件推送）；
 *   - MockSidecar：内存模拟，带电量、位置、移动和事件，供开发、测试和没有真机时使用。
 */

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

// ---------------------------------------------------------------- 事件

export type RobotEventType =
  | 'nav.started'
  | 'nav.arrived'
  | 'nav.failed'
  | 'person.detected'
  | 'person.lost'
  | 'asr'
  | 'battery'
  | 'estop'
  | 'connection';

export interface RobotEvent {
  type: RobotEventType;
  /** 毫秒时间戳。 */
  at: number;
  /** nav.*：地点名。 */
  location?: string;
  /** nav.*：sidecar 回传的动作 id（发起 goto 时传入）。 */
  action_id?: string;
  /** nav.failed：原因。 */
  reason?: string;
  /** asr：识别到的话。 */
  text?: string;
  /** battery：电量百分比；charging：是否在充电。 */
  battery?: number;
  charging?: boolean;
  /** connection：是否连上真机。 */
  connected?: boolean;
  /** estop：谁按的（App 急停时是同学 id）。 */
  by?: string;
}

export type RobotEventListener = (e: RobotEvent) => void;

// ---------------------------------------------------------------- 状态与结果

export interface RobotStatus {
  online: boolean;
  mock: boolean;
  battery: number | null;
  charging: boolean;
  is_moving: boolean;
  /** 最近一次到达的地点。 */
  location: string | null;
  /** 正在前往的地点。 */
  heading_to: string | null;
}

export interface SidecarResult<T = Record<string, unknown>> {
  ok: boolean;
  data?: T;
  error?: string;
}

export interface PhotoResult {
  /** 机器人是否真的拍到了照片（真机暂未实现时为 false）。 */
  captured: boolean;
  people_present?: number | null;
  availability_hint?: string;
  notes?: string | null;
  image_base64?: string | null;
}

export interface RobotSidecar {
  readonly mock: boolean;
  status(): Promise<SidecarResult<RobotStatus>>;
  say(text: string): Promise<SidecarResult>;
  /** 问一句话，返回识别到的回答（没听到为 null）。 */
  ask(question: string): Promise<SidecarResult<{ reply: string | null }>>;
  /** 发出导航指令；到达 / 失败通过事件回来（同时 sidecar 也会在 HTTP 响应里给最终结果）。 */
  goto(location: string, actionId: string): Promise<SidecarResult<{ arrived: boolean; message?: string }>>;
  turn(deg: number): Promise<SidecarResult>;
  tilt(deg: number): Promise<SidecarResult>;
  follow(on: boolean): Promise<SidecarResult>;
  stop(): Promise<SidecarResult>;
  photo(context?: string): Promise<SidecarResult<PhotoResult>>;
  detectPerson(timeoutMs: number): Promise<SidecarResult<{ present: boolean; confidence: number }>>;
  saveLocation(name: string): Promise<SidecarResult>;
  deleteLocation(name: string): Promise<SidecarResult>;
  onEvent(fn: RobotEventListener): () => void;
  /** 开始接收事件（HttpSidecar 连 /events/ws）。 */
  start?(): void;
  close?(): void;
}

// ---------------------------------------------------------------- HTTP 实现

export interface HttpSidecarOptions {
  baseUrl: string;
  /** 普通指令超时（导航单独 90 秒）。 */
  timeoutMs?: number;
  /** 事件流断线后多久重连。 */
  reconnectMs?: number;
  onError?: (e: unknown) => void;
}

export class HttpSidecar implements RobotSidecar {
  readonly mock = false;
  private bus = new EventEmitter();
  private ws?: WebSocket;
  private closed = false;
  private retry?: NodeJS.Timeout;

  constructor(private opts: HttpSidecarOptions) {
    this.bus.setMaxListeners(50);
  }

  private async req<T = Record<string, unknown>>(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs?: number): Promise<SidecarResult<T>> {
    try {
      const res = await fetch(`${this.opts.baseUrl.replace(/\/$/, '')}${path}`, {
        method,
        headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs ?? this.opts.timeoutMs ?? 15_000),
      });
      const text = await res.text();
      let data: unknown;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = { raw: text };
      }
      if (!res.ok) return { ok: false, error: `机器人服务返回 ${res.status}：${text.slice(0, 200)}` };
      const d = data as { ok?: boolean; error?: string | null; message?: string };
      if (d && typeof d === 'object' && d.ok === false) return { ok: false, data: data as T, error: d.error ?? d.message ?? '机器人执行失败' };
      return { ok: true, data: data as T };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: /abort|timeout/i.test(msg) ? '机器人没有响应（超时）' : `连不上机器人服务：${msg}` };
    }
  }

  async status(): Promise<SidecarResult<RobotStatus>> {
    const r = await this.req<{ connected?: boolean; mock?: boolean; battery?: number; charging?: boolean; is_moving?: boolean; location?: string | null; heading_to?: string | null }>('GET', '/status', undefined, 5_000);
    if (!r.ok || !r.data) return { ok: false, error: r.error };
    const d = r.data;
    return {
      ok: true,
      data: {
        online: !!d.connected || !!d.mock,
        mock: !!d.mock,
        battery: typeof d.battery === 'number' ? d.battery : null,
        charging: !!d.charging,
        is_moving: !!d.is_moving,
        location: d.location ?? null,
        heading_to: d.heading_to ?? null,
      },
    };
  }

  say(text: string) {
    return this.req('POST', '/speak', { text });
  }
  ask(question: string) {
    return this.req<{ reply: string | null }>('POST', '/ask', { sentence: question }, 60_000);
  }
  async goto(location: string, actionId: string) {
    const r = await this.req<{ ok: boolean; message?: string; arrived?: boolean | null }>('POST', '/goto', { location, action_id: actionId }, 90_000);
    // 只有 sidecar 明确回报收到到达事件才算到达；旧 sidecar 没有这个字段，一律按「未确认」处理
    return r.ok ? { ok: true, data: { arrived: r.data?.arrived === true, message: r.data?.message } } : { ok: false, error: r.error };
  }
  turn(deg: number) {
    return this.req('POST', '/turn', { angle: deg });
  }
  tilt(deg: number) {
    return this.req('POST', '/tilt', { angle: deg });
  }
  follow(on: boolean) {
    return on ? this.req('POST', '/be-with-me', {}) : this.req('POST', '/stop-movement', {});
  }
  stop() {
    return this.req('POST', '/stop', { immediate: true }, 5_000);
  }
  async photo(context?: string) {
    const r = await this.req<PhotoResult & { ok?: boolean }>('POST', '/photo', { context: context ?? null, return_image: true }, 30_000);
    if (!r.ok || !r.data) return { ok: false, error: r.error };
    const d = r.data;
    return { ok: true, data: { ...d, captured: !!d.image_base64 || typeof d.people_present === 'number' } };
  }
  async detectPerson(timeoutMs: number) {
    const r = await this.req<{ open_id?: string | null; confidence?: number; present?: boolean }>('POST', '/detect-person', { timeout_ms: timeoutMs }, timeoutMs + 5_000);
    if (!r.ok || !r.data) return { ok: false, error: r.error };
    const conf = r.data.confidence ?? 0;
    return { ok: true, data: { present: r.data.present ?? conf > 0, confidence: conf } };
  }
  saveLocation(name: string) {
    return this.req('POST', '/save-location', { location: name });
  }
  deleteLocation(name: string) {
    return this.req('POST', '/delete-location', { location: name });
  }

  onEvent(fn: RobotEventListener) {
    this.bus.on('event', fn);
    return () => void this.bus.off('event', fn);
  }

  start() {
    if (this.ws || this.closed) return;
    const url = `${this.opts.baseUrl.replace(/^http/, 'ws').replace(/\/$/, '')}/events/ws`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.on('message', (raw) => {
      try {
        const e = JSON.parse(String(raw)) as RobotEvent;
        if (e && typeof e.type === 'string') this.bus.emit('event', { ...e, at: e.at ?? Date.now() });
      } catch {
        /* 忽略非 JSON */
      }
    });
    const again = () => {
      this.ws = undefined;
      if (this.closed) return;
      this.retry = setTimeout(() => this.start(), this.opts.reconnectMs ?? 5_000);
    };
    ws.on('close', again);
    ws.on('error', (e) => {
      this.opts.onError?.(e);
      ws.close();
    });
  }

  close() {
    this.closed = true;
    if (this.retry) clearTimeout(this.retry);
    this.ws?.close();
  }
}

// ---------------------------------------------------------------- 模拟实现

export interface MockSidecarOptions {
  battery?: number;
  location?: string;
  /** 模拟导航耗时（毫秒），默认 30。 */
  travelMs?: number;
  /** ask 的模拟回答。 */
  askReply?: string | null;
  /** 这些地点导航会失败（模拟被挡住）。 */
  unreachable?: string[];
  /** 模拟「人在不在」。 */
  personPresent?: boolean;
}

export class MockSidecar implements RobotSidecar {
  readonly mock = true;
  readonly log: Array<{ cmd: string; arg?: unknown }> = [];
  private bus = new EventEmitter();
  state: RobotStatus;
  saved = new Set<string>();
  private travel?: { timer: NodeJS.Timeout; resolve: (r: SidecarResult<{ arrived: boolean; message?: string }>) => void; location: string; actionId: string };

  constructor(public opts: MockSidecarOptions = {}) {
    this.state = { online: true, mock: true, battery: opts.battery ?? 87, charging: false, is_moving: false, location: opts.location ?? '充电桩', heading_to: null };
    this.bus.setMaxListeners(50);
  }

  emit(e: Omit<RobotEvent, 'at'> & { at?: number }) {
    this.bus.emit('event', { at: Date.now(), ...e });
  }

  async status() {
    return { ok: true, data: { ...this.state } };
  }
  async say(text: string) {
    this.log.push({ cmd: 'say', arg: text });
    return { ok: true };
  }
  async ask(question: string) {
    this.log.push({ cmd: 'ask', arg: question });
    return { ok: true, data: { reply: this.opts.askReply === undefined ? '好的' : this.opts.askReply } };
  }
  goto(location: string, actionId: string): Promise<SidecarResult<{ arrived: boolean; message?: string }>> {
    this.log.push({ cmd: 'goto', arg: location });
    this.cancelTravel('被新的导航指令取代');
    this.state.is_moving = true;
    this.state.heading_to = location;
    this.emit({ type: 'nav.started', location, action_id: actionId });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.travel = undefined;
        this.state.is_moving = false;
        this.state.heading_to = null;
        if (this.opts.unreachable?.includes(location)) {
          this.emit({ type: 'nav.failed', location, action_id: actionId, reason: '路线被挡住' });
          resolve({ ok: false, error: '路线被挡住' });
          return;
        }
        this.state.location = location;
        this.state.battery = Math.max(0, (this.state.battery ?? 0) - 1);
        this.emit({ type: 'nav.arrived', location, action_id: actionId });
        resolve({ ok: true, data: { arrived: true } });
      }, this.opts.travelMs ?? 30);
      this.travel = { timer, resolve, location, actionId };
    });
  }
  private cancelTravel(reason: string) {
    if (!this.travel) return;
    clearTimeout(this.travel.timer);
    const t = this.travel;
    this.travel = undefined;
    this.state.is_moving = false;
    this.state.heading_to = null;
    this.emit({ type: 'nav.failed', location: t.location, action_id: t.actionId, reason });
    t.resolve({ ok: false, error: reason });
  }
  async turn(deg: number) {
    this.log.push({ cmd: 'turn', arg: deg });
    return { ok: true };
  }
  async tilt(deg: number) {
    this.log.push({ cmd: 'tilt', arg: deg });
    return { ok: true };
  }
  async follow(on: boolean) {
    this.log.push({ cmd: 'follow', arg: on });
    this.state.is_moving = on;
    return { ok: true };
  }
  async stop() {
    this.log.push({ cmd: 'stop' });
    this.cancelTravel('已急停');
    this.state.is_moving = false;
    this.emit({ type: 'estop' });
    return { ok: true };
  }
  async photo() {
    this.log.push({ cmd: 'photo' });
    const n = this.opts.personPresent === false ? 0 : 1;
    return { ok: true, data: { captured: true, people_present: n, availability_hint: n ? 'present' : 'absent', notes: '（模拟）画面' } };
  }
  async detectPerson() {
    const present = this.opts.personPresent !== false;
    return { ok: true, data: { present, confidence: present ? 0.9 : 0 } };
  }
  async saveLocation(name: string) {
    this.saved.add(name);
    return { ok: true };
  }
  async deleteLocation(name: string) {
    this.saved.delete(name);
    return { ok: true };
  }
  onEvent(fn: RobotEventListener) {
    this.bus.on('event', fn);
    return () => void this.bus.off('event', fn);
  }
}
