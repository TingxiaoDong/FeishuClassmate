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
 * Rank skills by keyword overlap with the query. Returns all skills when
 * `query` is empty (session start), best matches otherwise.
 */
export function selectSkills(skills: SkillDoc[], query: string, limit = 3): SkillDoc[] {
  if (!query.trim()) return skills.slice(0, limit);
  const terms = new Set(
    query
      .toLowerCase()
      .split(/[^\p{L}\p{N}_-]+/u)
      .filter((t) => t.length >= 2),
  );
  const scored = skills.map((s) => {
    const hay = `${s.name}\n${s.description}`.toLowerCase();
    let score = 0;
    for (const t of terms) if (hay.includes(t)) score += 1;
    return { s, score };
  });
  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.s);
}

/** Render skills into a system-prompt section (MetaClaw-style injection). */
export function buildSkillsPrompt(skills: SkillDoc[]): string {
  if (skills.length === 0) return '';
  const parts = skills.map(
    (s) => `## Skill: ${s.name}\n\n${s.description ? `${s.description}\n\n` : ''}${s.body.trim()}`,
  );
  return `# Available Skills\n\n${parts.join('\n\n---\n\n')}`;
}
