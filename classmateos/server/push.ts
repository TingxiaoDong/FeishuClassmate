/**
 * 推送通知抽象层（PLAN 移动端能力，P3 骨架）。
 *
 * PushProvider 抽象 APNs(iOS)/FCM(Android) 的发送语义；本仓库内只提供
 * MemoryPushProvider（记录所有发送，供测试与开发联调）。真实 APNs/FCM
 * 实现需要平台证书/服务账号，属外部环境项——接入时实现同一接口即可，
 * 业务路由与事件触发链路不需要改动。
 *
 * 触发链路：message.receive 事件 → 会话成员（除发送者）名下设备 → provider。
 */

export interface PushMessage {
  title: string;
  body: string;
  /** 透传给客户端做路由（如打开对应 chat）。 */
  data?: Record<string, string>;
}

export interface Device {
  device_id: string;
  user_id: string;
  platform: 'ios' | 'android' | 'macos';
  device_token: string;
  created_at: string;
}

export interface PushProvider {
  readonly name: string;
  send(deviceToken: string, platform: 'ios' | 'android' | 'macos', msg: PushMessage): Promise<void>;
}

/** 记录型 provider：测试断言与本地开发联调用。 */
export class MemoryPushProvider implements PushProvider {
  readonly name = 'memory';
  readonly sent: Array<{ device_token: string; platform: 'ios' | 'android' | 'macos'; msg: PushMessage }> = [];

  async send(deviceToken: string, platform: 'ios' | 'android' | 'macos', msg: PushMessage): Promise<void> {
    this.sent.push({ device_token: deviceToken, platform, msg });
  }
}

/**
 * APNs provider 占位：真实实现需 APNs key（.p8）与团队配置；
 * 未配置时发送即抛错，避免静默丢消息。
 */
export class ApnsPushProvider implements PushProvider {
  readonly name = 'apns';
  constructor(private readonly config?: { keyId: string; teamId: string; bundleId: string }) {}

  async send(): Promise<void> {
    if (!this.config) {
      throw new Error('APNs 未配置（需要 keyId/teamId/bundleId 与 .p8 密钥）——外部环境项');
    }
    throw new Error('APNs HTTP/2 发送未实现：接入时替换本方法（接口已稳定）');
  }
}

/**
 * FCM provider 占位：真实实现需 Firebase 服务账号 JSON。
 */
export class FcmPushProvider implements PushProvider {
  readonly name = 'fcm';
  constructor(private readonly config?: { projectId: string; serviceAccountJson: string }) {}

  async send(): Promise<void> {
    if (!this.config) {
      throw new Error('FCM 未配置（需要 projectId 与服务账号）——外部环境项');
    }
    throw new Error('FCM v1 API 发送未实现：接入时替换本方法（接口已稳定）');
  }
}
