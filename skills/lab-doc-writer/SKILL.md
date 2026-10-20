---
name: lab-doc-writer
description: 写文档 / 写说明 / 写指南 / 写方案 / 整理成文档 / 在文档里补充内容。同学说「写一篇…」「整理成文档」「在那篇文档后面加…」时使用。
---
# 写文档

## 步骤
1. **确定结构**：同学给了章节就照着写；没给就按「背景 → 正文分节 → 下一步 / 注意事项」组织，每节 2-5 句，宁短勿水。
2. **Markdown 格式**：一级标题用文档标题，节用 `##`，列表用 `-`，表格用 Markdown 表格；不要用 HTML。
3. **新文档**：`cos_write_doc(title, markdown)`；同学说「发到群里 / 发给某人」时同一次调用填 share_chat_id / share_to。
4. **改已有文档**：`cos_search` 或 `cos_doc(list, keyword)` 找到 doc_id；补充内容用 `cos_doc(append)`；要重写才用 `update`，并先 `get` 读原文、保留同学没让改的部分。
5. **引用平台数据**：写进度、统计类文档前先用 cos_table_stats / cos_task / cos_calendar 取真实数据，不要编数字。

## 回复
- 一句话说明写了什么、分几节；有没有分享出去；哪些内容是你补的需要同学核对。
