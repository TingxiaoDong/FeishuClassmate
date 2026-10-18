/**
 * Yjs 协同编辑服务端（PLAN 文档行「协同可用 Yjs」，P3 深化）。
 *
 * y-websocket v3 已移除服务端工具，这里用 y-protocols 实现最小同步协议：
 *   message type 0 = sync（step1/step2/update，readSyncMessage 处理）
 *   message type 1 = awareness（不解析，原样转发给其他连接，提供在线状态）
 *
 * 房间模型：按 doc_id 懒建 Y.Doc（首次无持久化状态时用 markdown 播种），
 * 最后一个连接断开时经 onPersist 回调把 encodeStateAsUpdate 的 base64
 * 交回宿主存储，随后销毁房间。宿主（app.ts）负责鉴权与落库。
 */

import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import type { WebSocket } from 'ws';

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;

export interface CollabHooks {
  /** 房间首建时取初始状态；yjs_update 优先，否则用 markdown 播种。 */
  loadSeed(docId: string): { markdown: string; yjs_update?: string } | undefined;
  /** 房间关闭（最后一个连接断开）时持久化全量 update（base64）。 */
  onPersist(docId: string, yjsUpdateBase64: string): void;
}

interface Room {
  doc: Y.Doc;
  conns: Set<WebSocket>;
}

export class CollabHub {
  private readonly rooms = new Map<string, Room>();

  constructor(private readonly hooks: CollabHooks) {}

  /** 当前活跃房间数（测试/观测用）。 */
  get roomCount(): number {
    return this.rooms.size;
  }

  handleConnection(docId: string, socket: WebSocket): boolean {
    const seed = this.hooks.loadSeed(docId);
    if (!seed) return false; // 文档不存在，由调用方关闭连接
    let room = this.rooms.get(docId);
    if (!room) {
      const doc = new Y.Doc();
      if (seed.yjs_update) {
        Y.applyUpdate(doc, Buffer.from(seed.yjs_update, 'base64'));
      } else if (seed.markdown) {
        doc.getText('markdown').insert(0, seed.markdown);
      }
      room = { doc, conns: new Set() };
      this.rooms.set(docId, room);
      // 本连接产生的 update → 广播给同房间其他连接
      doc.on('update', (update: Uint8Array, origin: unknown) => {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MSG_SYNC);
        syncProtocol.writeUpdate(encoder, update);
        const msg = encoding.toUint8Array(encoder);
        for (const conn of room.conns) {
          if (conn !== origin && conn.readyState === conn.OPEN) conn.send(msg);
        }
      });
    }
    room.conns.add(socket);

    // 握手：sync step1（携带我方 state vector，客户端回 step2）
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeSyncStep1(enc, room.doc);
    socket.send(encoding.toUint8Array(enc));

    socket.on('message', (data: Buffer) => {
      const buf = new Uint8Array(data);
      const decoder = decoding.createDecoder(buf);
      const msgType = decoding.readVarUint(decoder);
      if (msgType === MSG_SYNC) {
        const reply = encoding.createEncoder();
        encoding.writeVarUint(reply, MSG_SYNC);
        syncProtocol.readSyncMessage(decoder, reply, room.doc, socket);
        if (encoding.length(reply) > 1) socket.send(encoding.toUint8Array(reply));
      } else if (msgType === MSG_AWARENESS) {
        for (const conn of room.conns) {
          if (conn !== socket && conn.readyState === conn.OPEN) conn.send(buf);
        }
      }
    });

    socket.on('close', () => {
      room.conns.delete(socket);
      if (room.conns.size === 0) {
        this.hooks.onPersist(docId, Buffer.from(Y.encodeStateAsUpdate(room.doc)).toString('base64'));
        room.doc.destroy();
        this.rooms.delete(docId);
      }
    });
    return true;
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
