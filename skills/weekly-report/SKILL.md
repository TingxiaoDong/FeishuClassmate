---
name: weekly-report
description: 周报 / 周总结 / 本周进展汇总 / 项目进度报告 / 每周自动写周报。同学要写周报、汇总一周工作、或设置「每周五自动生成周报」时使用。
---
# 周报

## 数据来源（按需取，取真实数据）
- 自己的任务：`cos_task(list, assignee_id=本人)`，按 done / 进行中 / 逾期分组；本周完成的看更新时间。
- 日程：`cos_daily_brief(range=week)` 或 `cos_calendar(list)` 本周开过的会。
- 项目表：同学指定了进度表就用 `cos_table_stats` 拿完成情况分布。
- 同学口述的内容优先，平台数据补充。

## 文档结构（cos_write_doc）
标题「周报 YYYY-MM-DD（第 N 周）」：
- `## 本周完成`  `## 进行中`  `## 遇到的问题`  `## 下周计划`
- 每条一句话；数字来自工具结果；没有数据的节写「暂无」。

## 发出去
- 同学说发群 / 发导师：`share_chat_id` 或 `share_to`。

## 每周自动
- 同学说「以后每周五下午帮我写周报」：`cos_automation(create, event=schedule, cron="0 17 * * 5", prompt="按 weekly-report 技能为我写本周周报，并发到群 XX")`，填 chat_id。设置后复述「每周五 17:00 自动生成并发到 XX」。
