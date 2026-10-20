---
name: lab-table-builder
description: 做表格 / 建多维表格 / 登记表 / 统计表 / 往表里加数据 / 汇总表格。同学说「建一张…表」「帮我登记」「统计一下」「把这些数据整理成表」时使用。
---
# 做表格

## 步骤
1. **先想清楚列**：从同学的话里提取列名；没说的常用列可以补 1-2 个（如登记表补「备注」），但要在回复里说明补了什么。
2. **选列类型**：人名 → person；日期 → date；数量 / 金额 → number；固定几种状态 → single_select（给出 options）；是否 → checkbox；其他 text。第一列放最能代表一行的内容（器材名、姓名、标题）。
3. **建表并填数据一步完成**：`cos_build_table(name, fields, rows)`，rows 用列标题写值，人名、日期（2026-10-21）、数字直接写。
4. **往已有的表加数据**：先 `cos_table(action=list_tables)` 找到 table_key（「刚才那张表」看工作记忆），再 `cos_table_add_rows`。
5. **统计**：`cos_table_stats` 拿到总数 / 分布 / 合计后用一两句话说结论，不要贴原始 JSON。
6. **改数据**：少量改用 `cos_table(update_records)`，先 list_records 找 record_id；超过 20 条系统会弹确认卡片。

## 回复
- 说清表名、有哪些列、写入了几行；工具返回 problems 时逐条告诉同学（如「王芳有两个人，没填借用人」）。
- 不要承诺链接可以点开。
