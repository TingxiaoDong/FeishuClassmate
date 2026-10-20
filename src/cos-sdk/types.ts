/**
 * ClassmateOS SDK 公共类型（AGENT_PLAN §2.1）。
 */

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/** 接口目录条目（scripts/gen-cos-catalog.mjs 从服务端路由生成）。 */
export interface CosApiEntry {
  method: string;
  /** 不含 /api/v1 前缀，参数写成 :name。 */
  path: string;
  /** 资源分组：table / doc / calendar / task / im / drive / contact / notify / workbench / other */
  group: string;
  summary: string;
}

/** 这次调用代表谁、来自哪个会话（服务端写审计用）。 */
export interface CosActor {
  /** 代表哪位同学操作（X-On-Behalf-Of）。 */
  userId?: string;
  sessionId?: string;
  toolCallId?: string;
  /** 同学确认过的卡片 id（X-Agent-Confirm），服务端凭它放行删除类操作。 */
  confirmCardId?: string;
}

export type CosResult<T = unknown> =
  | { ok: true; status: number; data: T }
  | {
      ok: false;
      status: number;
      error: string;
      code?: string;
      /** 服务端返回的字段校验错误等。 */
      details?: unknown;
    };

export interface CosRequest {
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  actor?: CosActor;
  signal?: AbortSignal;
  /** 以 bot 自身身份调用 /bot/* 接口时为 true（不带 X-On-Behalf-Of）。 */
  asBot?: boolean;
}
