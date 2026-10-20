/**
 * Skills loader (PLAN §1.2-A8).
 *
 * Scans `skills/<name>/SKILL.md`, parses YAML frontmatter, and injects the
 * relevant skills into the system prompt — mirroring MetaClaw's injection
 * semantics so the same SKILL.md files work whether or not the proxy is in
 * the loop.
 *
 * Relevance is intentionally simple (keyword overlap over name + description +
 * body headings); MetaClaw does the smart retrieval when present — this is the
 * offline/保底 path.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

export interface SkillDoc {
  /** Directory name, e.g. 'manage-project'. */
  id: string;
  name: string;
  description: string;
  /** Absolute path to SKILL.md. */
  path: string;
  /** Full markdown body (frontmatter stripped). */
  body: string;
}

/** Load every skills/<id>/SKILL.md under `skillsDir`. Never throws on a bad skill. */
export function loadSkills(skillsDir: string): SkillDoc[] {
  if (!existsSync(skillsDir)) return [];
  const out: SkillDoc[] = [];
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(skillsDir, entry.name, 'SKILL.md');
    if (!existsSync(path)) continue;
    try {
      out.push(parseSkillFile(entry.name, path, readFileSync(path, 'utf8')));
    } catch {
      // Skip malformed skills rather than failing the whole scan.
    }
  }
  return out;
}

function parseSkillFile(id: string, path: string, text: string): SkillDoc {
  let name = id;
  let description = '';
  let body = text;

  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (m) {
    const fm = parseYaml(m[1]) as Record<string, unknown> | null;
    if (fm && typeof fm === 'object') {
      if (typeof fm.name === 'string') name = fm.name;
      if (typeof fm.description === 'string') description = fm.description;
    }
    body = text.slice(m[0].length);
  }
  return { id, name, description, path, body };
}

/**
 * 中英文混合的检索词：英文 / 数字按词切，中文按相邻两字切（「会议预约」→ 会议、议预、预约）。
 */
export function searchTerms(text: string): Set<string> {
  const out = new Set<string>();
  const lower = text.toLowerCase();
  for (const w of lower.split(/[^a-z0-9_-]+/)) if (w.length >= 2) out.add(w);
  for (const run of lower.match(/[\u4e00-\u9fff]+/g) ?? []) {
    if (run.length === 1) continue;
    for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2));
  }
  return out;
}

/** 同学常说的话 → skill 描述里常见的词（扩展检索词，提高召回）。 */
const SYNONYMS: Array<[RegExp, string]> = [
  [/(开会|约会|会议|约个时间|碰一下|组会)/, '会议 预约 日程'],
  [/(论文|文献|paper|期刊|顶会)/, '论文 检索 academic paper search'],
  [/(参观|导览|带.*看看|来访|访客)/, '导览 参观 lab tour'],
  [/(temi|机器人|小车)/i, 'temi 机器人'],
  [/(项目|进度|ddl|截止|甘特)/i, '项目 进度 管理'],
  [/(调研|研究方向|课题|前沿)/, '研究 课题 research'],
];

/**
 * 按问题挑 skills（AGENT_PLAN M2）：名称 / 描述权重高，正文命中少量加分。
 * query 为空时（会话开始）按原顺序取前 limit 个。
 */
export function selectSkills(skills: SkillDoc[], query: string, limit = 3): SkillDoc[] {
  if (!query.trim()) return skills.slice(0, limit);
  let expanded = query;
  for (const [re, extra] of SYNONYMS) if (re.test(query)) expanded += ` ${extra}`;
  const terms = searchTerms(expanded);
  if (!terms.size) return [];
  const scored = skills.map((s) => {
    const head = `${s.id}\n${s.name}\n${s.description}`.toLowerCase();
    const body = s.body.slice(0, 4000).toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (head.includes(t)) score += 3;
      else if (body.includes(t)) score += 0.5;
    }
    return { s, score };
  });
  return scored
    .filter((x) => x.score >= 3)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.s);
}

/** 没被选中的 skills 只列名字和一句话描述，模型知道有哪些能力。 */
export function buildSkillsIndex(skills: SkillDoc[]): string {
  if (!skills.length) return '';
  const lines = skills.map((s) => `- ${s.name}：${s.description.replace(/\s+/g, ' ').slice(0, 80)}`);
  return `# 其他可用技能（未展开）\n\n${lines.join('\n')}`;
}

/** Render skills into a system-prompt section (MetaClaw-style injection). */
export function buildSkillsPrompt(skills: SkillDoc[]): string {
  if (skills.length === 0) return '';
  const parts = skills.map(
    (s) => `## Skill: ${s.name}\n\n${s.description ? `${s.description}\n\n` : ''}${s.body.trim()}`,
  );
  return `# Available Skills\n\n${parts.join('\n\n---\n\n')}`;
}
