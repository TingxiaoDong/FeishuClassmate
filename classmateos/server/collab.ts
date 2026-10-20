/**
 * Yjs 协同编辑服务端（PLAN 文档行「协同可用 Yjs」，P3 深化）。
 *
 * y-websocket v3 已移除服务端工具，这里用 y-protocols 实现最小同步协议：
 *   message type 0 = sync（step1/step2/update，readSyncMessage 处理）
 *   message type 1 = awareness（在线状态）：转发前把每条状态里的 user_id / name
 *   改写成连接本人（防冒充）；连接断开时替它广播 null 状态（离开）。
 *
 * 房间模型：按 doc_id 懒建 Y.Doc（首次无持久化状态时用 markdown 播种），
 * 最后一个连接断开时经 onPersist 回调把 encodeStateAsUpdate 的 base64
 * 交回宿主存储，随后销毁房间。宿主（app.ts）负责鉴权与落库。
 *
 * 正文共享类型：`doc.getText('markdown')`（Y.Text，key = "markdown"）。
 * 只读连接（readOnly）：能收到同步和他人的修改，但发来的 step2 / update 被丢弃。
 * loadSeed 可以是异步的（PG 查库）：等待期间收到的消息先排队，房间就绪后按序处理。
 */

import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import type { WebSocket } from 'ws';

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
/** awareness 单条消息上限，超过直接丢弃。 */
const MAX_AWARENESS_BYTES = 16 * 1024;

export interface CollabIdentity {
  user_id: string;
  name: string;
}

interface ConnInfo {
  identity?: CollabIdentity;
  /** 这个连接用过的 awareness clientID → 最后的 clock。 */
  clients: Map<number, number>;
}

/** 解析 awareness 消息体（不含类型前缀）。格式错返回 undefined。 */
function decodeAwareness(decoder: decoding.Decoder): Array<{ clientId: number; clock: number; state: unknown }> | undefined {
  const update = decoding.readVarUint8Array(decoder);
  const d = decoding.createDecoder(update);
  const n = decoding.readVarUint(d);
  if (n > 64) return undefined;
  const out: Array<{ clientId: number; clock: number; state: unknown }> = [];
  for (let i = 0; i < n; i++) {
    const clientId = decoding.readVarUint(d);
    const clock = decoding.readVarUint(d);
    out.push({ clientId, clock, state: JSON.parse(decoding.readVarString(d)) });
  }
  return out;
}

function encodeAwareness(entries: Array<{ clientId: number; clock: number; state: unknown }>): Uint8Array {
  const u = encoding.createEncoder();
  encoding.writeVarUint(u, entries.length);
  for (const e of entries) {
    encoding.writeVarUint(u, e.clientId);
    encoding.writeVarUint(u, e.clock);
    encoding.writeVarString(u, JSON.stringify(e.state ?? null));
  }
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_AWARENESS);
  encoding.writeVarUint8Array(enc, encoding.toUint8Array(u));
  return encoding.toUint8Array(enc);
}

export interface CollabSeed {
  markdown: string;
  yjs_update?: string | null;
}

export interface CollabHooks {
  /** 房间首建时取初始状态；yjs_update 优先，否则用 markdown 播种。 */
  loadSeed(docId: string): CollabSeed | undefined | Promise<CollabSeed | undefined>;
  /** 房间关闭（最后一个连接断开）时持久化全量 update（base64）。 */
  onPersist(docId: string, yjsUpdateBase64: string): void | Promise<void>;
}

interface Room {
  doc: Y.Doc;
  conns: Set<WebSocket>;
  /** 被 closeRoom 关闭时不再持久化。 */
  closed: boolean;
}

export class CollabHub {
  private readonly rooms = new Map<string, Room>();
  private readonly pendingRooms = new Map<string, Promise<Room | undefined>>();
  private readonly connInfo = new WeakMap<WebSocket, ConnInfo>();

  constructor(private readonly hooks: CollabHooks) {}

  /** 当前活跃房间数（测试/观测用）。 */
  get roomCount(): number {
    return this.rooms.size;
  }

  private createRoom(seed: CollabSeed): Room {
    const doc = new Y.Doc();
    if (seed.yjs_update) {
      Y.applyUpdate(doc, Buffer.from(seed.yjs_update, 'base64'));
    } else if (seed.markdown) {
      doc.getText('markdown').insert(0, seed.markdown);
    }
    const room: Room = { doc, conns: new Set(), closed: false };
    // 某连接产生的 update → 广播给同房间其他连接
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MSG_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      const msg = encoding.toUint8Array(encoder);
      for (const conn of room.conns) {
        if (conn !== origin && conn.readyState === conn.OPEN) conn.send(msg);
      }
    });
    return room;
  }

  private async roomFor(docId: string): Promise<Room | undefined> {
    const existing = this.rooms.get(docId);
    if (existing) return existing;
    let pending = this.pendingRooms.get(docId);
    if (!pending) {
      pending = (async () => {
        const seed = await this.hooks.loadSeed(docId);
        if (!seed) return undefined;
        const again = this.rooms.get(docId);
        if (again) return again;
        const room = this.createRoom(seed);
        this.rooms.set(docId, room);
        return room;
      })().finally(() => this.pendingRooms.delete(docId));
      this.pendingRooms.set(docId, pending);
    }
    return pending;
  }

  private handleMessage(room: Room, socket: WebSocket, data: Buffer, readOnly: boolean) {
    const buf = new Uint8Array(data);
    const decoder = decoding.createDecoder(buf);
    const msgType = decoding.readVarUint(decoder);
    if (msgType === MSG_SYNC) {
      if (readOnly) {
        // 只处理 step1（请求我方状态），丢弃 step2 / update
        const sub = decoding.peekVarUint(decoder);
        if (sub !== syncProtocol.messageYjsSyncStep1) return;
      }
      const reply = encoding.createEncoder();
      encoding.writeVarUint(reply, MSG_SYNC);
      syncProtocol.readSyncMessage(decoder, reply, room.doc, socket);
      if (encoding.length(reply) > 1) socket.send(encoding.toUint8Array(reply));
    } else if (msgType === MSG_AWARENESS) {
      if (buf.length > MAX_AWARENESS_BYTES) return;
      const info = this.connInfo.get(socket);
      const entries = decodeAwareness(decoder);
      if (!entries || !info) return;
      for (const e of entries) {
        // 其他连接的 clientID 不能被这个连接改写
        if (!info.clients.has(e.clientId) && this.clientOwnedElsewhere(room, socket, e.clientId)) return;
        info.clients.set(e.clientId, e.clock);
        if (e.state && typeof e.state === 'object' && !Array.isArray(e.state) && info.identity) {
          e.state = { ...(e.state as Record<string, unknown>), user_id: info.identity.user_id, name: info.identity.name };
        } else if (e.state !== null) {
          e.state = null;
        }
      }
      this.broadcast(room, socket, encodeAwareness(entries));
    }
  }

  private clientOwnedElsewhere(room: Room, socket: WebSocket, clientId: number): boolean {
    for (const conn of room.conns) {
      if (conn !== socket && this.connInfo.get(conn)?.clients.has(clientId)) return true;
    }
    return false;
  }

  private broadcast(room: Room, from: WebSocket, msg: Uint8Array) {
    for (const conn of room.conns) {
      if (conn !== from && conn.readyState === conn.OPEN) conn.send(msg);
    }
  }

  /**
   * 接入一个协同连接。监听器同步注册（异步加载期间的消息会排队）。
   * 文档不存在时以 4404 关闭连接。
   */
  handleConnection(
    docId: string,
    socket: WebSocket,
    opts: { readOnly?: boolean | Promise<boolean>; identity?: CollabIdentity | Promise<CollabIdentity | undefined> } = {},
  ): Promise<boolean> {
    const info: ConnInfo = { clients: new Map() };
    this.connInfo.set(socket, info);
    void Promise.resolve(opts.identity).then((id) => { info.identity = id; }, () => undefined);
    let readOnly = true; // 权限确定前按只读处理（消息此时只会排队）
    const queue: Buffer[] = [];
    let room: Room | undefined;
    let closedEarly = false;

    socket.on('message', (data: Buffer) => {
      if (!room) {
        queue.push(data);
        return;
      }
      try {
        this.handleMessage(room, socket, data, readOnly);
      } catch {
        // 坏帧不影响房间
      }
    });

    socket.on('close', () => {
      closedEarly = true;
      if (!room) return;
      room.conns.delete(socket);
      if (info.clients.size > 0 && room.conns.size > 0) {
        this.broadcast(room, socket, encodeAwareness([...info.clients].map(([clientId, clock]) => ({ clientId, clock: clock + 1, state: null }))));
      }
      if (room.conns.size === 0 && this.rooms.get(docId) === room) {
        this.rooms.delete(docId);
        if (!room.closed) {
          const update = Buffer.from(Y.encodeStateAsUpdate(room.doc)).toString('base64');
          void Promise.resolve(this.hooks.onPersist(docId, update)).catch(() => undefined);
        }
        room.doc.destroy();
      }
    });

    return Promise.all([this.roomFor(docId), Promise.resolve(opts.readOnly ?? false), Promise.resolve(opts.identity)]).then(([r, ro, id]) => {
      readOnly = ro;
      info.identity = id;
      if (!r) {
        socket.close(4404, 'doc not found');
        return false;
      }
      if (closedEarly) return false;
      room = r;
      r.conns.add(socket);
      // 握手：sync step1（携带我方 state vector，客户端回 step2）
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.writeSyncStep1(enc, r.doc);
      socket.send(encoding.toUint8Array(enc));
      for (const data of queue.splice(0)) {
        try {
          this.handleMessage(r, socket, data, readOnly);
        } catch {
          // ignore
        }
      }
      return true;
    });
  }

  /** 文档被删除：断开该房间所有连接（关闭码 4404），不持久化。 */
  closeRoom(docId: string, code = 4404, reason = 'doc deleted'): void {
    const room = this.rooms.get(docId);
    if (!room) return;
    room.closed = true;
    this.rooms.delete(docId);
    for (const conn of room.conns) {
      try {
        conn.close(code, reason);
      } catch {
        // ignore
      }
    }
    room.conns.clear();
    room.doc.destroy();
  }
}

/** 从持久化的 Yjs update 提取纯文本（REST GET 用）。 */
export function collabTextFromUpdate(yjsUpdateBase64: string): string {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, Buffer.from(yjsUpdateBase64, 'base64'));
    return doc.getText('markdown').toString();
  } finally {
    doc.destroy();
  }
}
