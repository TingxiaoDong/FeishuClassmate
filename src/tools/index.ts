/**
 * feishu-classmate tool registry.
 *
 * Architectural principle: **prefer @larksuite/openclaw-lark's raw Bitable/Doc tools
 * over custom wrappers.** The official lark plugin already provides well-documented
 * tools for every Bitable/Doc/Drive/Wiki/Sheet/Task operation (see its skills/).
 *
 * What we register from our own plugin:
 *   - `data-layout`  : tells the agent which app_token / table_id to target
 *   - `temi/*`       : HTTP control of the Python Temi sidecar (not in lark)
 *   - `supervision/*`: stateful self-supervision sessions (in-memory state)
 *   - `chat/*`       : in-memory student interaction throttle / topic picker
 *   - `research/search-works`: arxiv search (bitable write is delegated to lark)
 *   - `research/arc/*`: async bridge to the AutoResearchClaw sidecar (idea validation)
 *
 * What we DO NOT register anymore (delegated to lark's raw bitable tools):
 *   - project_ingest / project_create
 *   - gantt_create / gantt_update_progress / gantt_list_today_nodes
 *   - equipment_query / equipment_borrow / equipment_return
 *   - research_pick_topic / research_publish
 * The agent now calls `feishu_bitable_app_table_record` / `feishu_bitable_app_table_field`
 * directly, using `feishu_classmate_data_layout` to discover the IDs.
 */

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { registerDataLayout } from './data-layout.js';
import { registerSupervisionTools } from './supervision/index.js';
import { registerTemiTools } from './temi/index.js';
import { registerChatTools } from './chat/index.js';
import { registerResearchSearchWorks } from './research/search-works.js';
import { registerResearchArcTools } from './research/arc/index.js';

export function registerAllTools(api: OpenClawPluginApi, opts: { legacyTemi?: boolean } = {}): void {
  registerDataLayout(api);
  registerSupervisionTools(api);
  if (opts.legacyTemi !== false) registerTemiTools(api);
  registerChatTools(api);
  registerResearchSearchWorks(api);
  registerResearchArcTools(api);
}
