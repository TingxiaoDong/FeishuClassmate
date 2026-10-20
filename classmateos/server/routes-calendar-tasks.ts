/**
 * 日历（第 10 节 + 二期 R-CA-01 重复日程）与任务（第 11 节 + 二期 R-TK-01 ~ 05）。
 * 具体实现见 routes-calendar.ts、routes-tasks.ts。
 */

import type { Ctx } from './context.js';
import type { NotificationService } from './notifications.js';
import type { Zone } from './rrule.js';
import { registerCalendarRoutes } from './routes-calendar.js';
import { registerTaskRoutes } from './routes-tasks.js';

export { eventJson } from './routes-calendar.js';
export { taskJson } from './routes-tasks.js';

export function registerCalendarTaskRoutes(
  ctx: Ctx,
  deps: { notifications?: NotificationService; calendarZone?: () => Zone } = {},
): void {
  registerCalendarRoutes(ctx, { defaultZone: deps.calendarZone ?? (() => 'Asia/Shanghai') });
  registerTaskRoutes(ctx, deps.notifications);
}
