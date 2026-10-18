# Contributing to 飞书同学 · Feishu Classmate

Thanks for your interest! 本项目欢迎各种形式的贡献 — 新 skill / bug fix / 文档 / 翻译 / 新场景设计。

## 快速开始

```bash
git clone https://github.com/TingxiaoDong/FeishuClassmate.git
cd feishu-classmate
pnpm install
pnpm build && pnpm typecheck && pnpm test
```

## 怎么加新 skill(最常见)

1. 在 `skills/<kebab-name>/` 新建目录
2. 创建 `SKILL.md`,照着 [`skills/manage-project/SKILL.md`](skills/manage-project/SKILL.md) 的模板
3. **只引用官方 lark 工具 + `feishu_classmate_data_layout`** — 不要写新的 zod 包装 tool
4. 提 PR,描述触发场景 + 有什么数据写入

> 详细 skill 写作规范见 [`docs/SKILL_AUTHORING.md`](docs/SKILL_AUTHORING.md)(TODO · 暂见 manage-project 范例)。

## 怎么加新 tool(慎重)

仅当 raw lark 搞不定的场景(硬件控制、内存状态、非 Feishu 服务)才考虑:

1. `src/tools/<group>/<name>.ts`,用 `registerZodTool(api, {...})`
2. 更新 `src/tools/index.ts`
3. 单元测试加到 `tests/tools/<group>.test.ts`
4. `pnpm build && pnpm test` 必须绿

## 代码规范

- TypeScript strict
- ESM only · Node 22+
- 禁 `any`(`unknown` + 类型缩小;除非是 SDK 边界)
- 新文件开头不写许可证头,README 已说明 MIT
- 提交前跑 `pnpm format`

## Commit 规范

Conventional commits 前缀:
- `feat:` 新功能
- `fix:` bug 修复
- `docs:` 纯文档
- `refactor:` 重构(非功能)
- `test:` 测试
- `chore:` 构建/依赖/CI

Scope(可选):`feat(skills): add reading-group`、`fix(bitable): handle missing tableId`。

## PR 流程

1. Fork + 建分支(`feat/<short>`)
2. 按上面规范实装
3. 本地 `pnpm build && pnpm test` 必须全绿
4. 提 PR,填写模板
5. 等 CI(GitHub Actions)通过
6. 审核通过后 squash merge 到 `main`

## 报 Bug / 提 Feature

- 用 issue 模板
- 附上 OpenClaw / plugin 版本、Feishu app 权限、最小复现

## 安全

发现安全问题**不要**开 public issue,直接邮件联系仓库所有者。
特别提醒:凭据 (飞书 App Secret / LLM API Key / tenant_access_token) 严禁提交。
`.env` 已 gitignore。

## Code of Conduct

尊重所有贡献者。不接受人身攻击、歧视性言论、sexual content。
违反者会被 ban from the org。

## License

By contributing, 你同意你的代码以 MIT 协议发布。
