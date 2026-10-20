/**
 * 启动配置检查（代码审查 B2）。main.ts 启动前调用；纯函数，方便测试。
 *
 * 生产模式：NODE_ENV=production 且没有设置 CLASSMATE_OS_DEV=1。
 *   - CLASSMATE_OS_SECRET / CLASSMATE_OS_BOT_TOKEN 必须设置、不能是开发默认值、至少 16 位 → 否则拒绝启动
 *   - 不创建 admin/admin、demo/demo 种子账号；CLASSMATE_OS_USERS 里的账号首次登录强制改密
 *   - 默认监听 0.0.0.0
 * 开发模式：允许默认值（打印警告），默认只监听 127.0.0.1；要让手机连就设 CLASSMATE_OS_HOST=0.0.0.0。
 */
import type { PlatformUser } from './app.js';

export const DEV_SECRET = 'dev-only-secret-change-me';
export const DEV_BOT_TOKEN = 'dev-bot-token';

export const DEV_USERS: PlatformUser[] = [
  { user_id: 'ou_admin', name: 'admin', password: 'admin', role: 'admin', department: 'ClassmateOS 实验室', title: '管理员' },
  { user_id: 'ou_demo', name: 'demo', password: 'demo', role: 'member', department: 'ClassmateOS 实验室' },
];

const WEAK_PASSWORDS = new Set(['admin', 'demo', 'password', '123456', '12345678', 'changeme']);

export interface StartupConfig {
  production: boolean;
  secret: string;
  botToken: string;
  host: string;
  users: PlatformUser[];
  /** 生产模式下种子账号首次登录必须改密。 */
  forcePasswordChange: boolean;
  errors: string[];
  warnings: string[];
}

export function checkStartupConfig(env: Record<string, string | undefined>): StartupConfig {
  const production = env.NODE_ENV === 'production' && env.CLASSMATE_OS_DEV !== '1';
  const errors: string[] = [];
  const warnings: string[] = [];

  const need = (name: string, value: string | undefined, devDefault: string) => {
    if (!value) {
      if (production) errors.push(`生产环境必须设置 ${name}`);
      else warnings.push(`${name} 没有设置，正在使用开发默认值，不要对外部署`);
      return devDefault;
    }
    if (value === devDefault) {
      if (production) errors.push(`${name} 不能使用开发默认值`);
      else warnings.push(`${name} 是开发默认值，不要对外部署`);
    } else if (production && value.length < 16) {
      errors.push(`${name} 太短（至少 16 位）`);
    }
    return value;
  };
  const secret = need('CLASSMATE_OS_SECRET', env.CLASSMATE_OS_SECRET, DEV_SECRET);
  const botToken = need('CLASSMATE_OS_BOT_TOKEN', env.CLASSMATE_OS_BOT_TOKEN, DEV_BOT_TOKEN);

  let users: PlatformUser[] = [];
  if (env.CLASSMATE_OS_USERS) {
    try {
      const parsed = JSON.parse(env.CLASSMATE_OS_USERS) as unknown;
      if (!Array.isArray(parsed)) throw new Error('not array');
      users = parsed as PlatformUser[];
    } catch {
      errors.push('CLASSMATE_OS_USERS 不是合法的 JSON 数组');
    }
    if (production) {
      for (const u of users) {
        if (typeof u?.password === 'string' && (WEAK_PASSWORDS.has(u.password.toLowerCase()) || u.password === u.name || u.password === u.user_id)) {
          errors.push(`种子账号 ${u.user_id} 的密码太弱`);
        }
      }
    }
  } else if (production) {
    warnings.push('生产环境没有设置 CLASSMATE_OS_USERS，不创建默认账号（已有账号不受影响）');
  } else {
    users = DEV_USERS;
  }

  const host = env.CLASSMATE_OS_HOST?.trim() || (production ? '0.0.0.0' : '127.0.0.1');
  return { production, secret, botToken, host, users, forcePasswordChange: production, errors, warnings };
}
