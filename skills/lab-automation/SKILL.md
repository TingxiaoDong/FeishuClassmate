---
name: lab-automation
description: 自动化 / 以后每当 / 每次有人 / 定时提醒 / 每周自动 / 表格有变化就通知我 / 取消自动化。同学希望飞书同学在某件事发生时或固定时间自动帮他做事时使用。
---
# 设置自动化

## 选触发方式
| 同学的说法 | event | 需要的参数 |
|---|---|---|
| 每周一 9 点… / 每天下班前… | schedule | cron（5 段，北京时间，如 `0 9 * * 1`、`0 18 * * 1-5`） |
| 某张表新增 / 修改了记录就… | record.changed | table_key（先 cos_table list_tables 找），可选 record_actions、fields_any |
| 有人给我派任务就… | task.assigned | — |
| 我的任务有更新就… | task.updated | — |
| 有人邀请我开会就… | calendar.invited | — |
| 我的文档有新评论就… | doc.comment_changed | — |

## 步骤
1. 用 `cos_automation(create)`：name 简短；prompt 写成触发时给飞书同学的一句完整指令（包含要做什么、结果发给谁）；需要判断时写 condition（如「状态变成已完成」）。
2. 结果发到群里就填 chat_id，不填会私聊同学。
3. 复述给同学：什么时候触发、做什么、发到哪；告诉他说「取消 XX 自动化」可以关掉。
4. 查看 / 暂停 / 删除：`cos_automation(list)` 找 trigger_id；暂停用 update enabled=false；删除会弹确认卡片。

## 限制
- 每人最多 20 个；同一个自动化两次触发至少间隔 1 分钟（默认 5 分钟）。
- 自动化以设置它的同学的身份运行，看不到他没权限的数据。
- 会让机器人移动的操作不要设成自动化。
