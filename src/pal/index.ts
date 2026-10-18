/**
 * PAL entry — adapter factory (PLAN §2.3).
 *
 * 通道选择：env CLASSMATE_PLATFORM = feishu | classmateos，默认 feishu
 * （灰度期保底，双跑可回切）。
 */

import type { ClassmateConfig } from '../config.js';
import { createFeishuAdapter } from './feishu-adapter.js';
import { createClassmateOSAdapter } from './classmateos-adapter.js';
import type { PlatformAdapter } from './types.js';

export type {
  AuthProvider,
  CalendarService,
  DocService,
  DriveService,
  ImService,
  PalMessage,
  PalMessageType,
  PalRecord,
  PalRecordFields,
  PalResult,
  PalUser,
  PlatformAdapter,
  TableService,
} from './types.js';
export { PalUnimplementedError } from './types.js';
export { createFeishuAdapter } from './feishu-adapter.js';
export { createClassmateOSAdapter } from './classmateos-adapter.js';
export type { ClassmateOSAdapterOptions } from './classmateos-adapter.js';

export function createPlatformAdapter(cfg: ClassmateConfig): PlatformAdapter {
  const platform = (process.env.CLASSMATE_PLATFORM ?? 'feishu').toLowerCase();
  if (platform === 'classmateos') {
    return createClassmateOSAdapter({
      baseUrl: process.env.CLASSMATE_OS_URL ?? 'http://localhost:8080/api/v1',
      accessToken: process.env.CLASSMATE_OS_TOKEN,
      botToken: process.env.CLASSMATE_OS_BOT_TOKEN,
    });
  }
  return createFeishuAdapter(cfg);
}
