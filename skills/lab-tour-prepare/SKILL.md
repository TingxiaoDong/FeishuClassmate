---
name: lab-tour-prepare
description: |
  教师/管理员为来访访客「预生成」个性化导览讲解稿时使用。
  读取知识库中的导览母版，自动识别访客单位信息并联网搜索公司背景，结合单位属性生成高度贴合访客兴趣的定制化导览稿，新建一篇飞书 Doc 作为当次剧本。
  **触发**: 「给 XX 单位准备导览」「生成今天的参观讲解稿」「预生成导览文档」。
  **个性化特性**: 自动识别用户输入中的公司名称，联网搜索公司主营业务、行业方向、技术需求、近期动态等信息，分析访客兴趣点后定制讲解大纲，重点展示与访客匹配的实验室成果。

  **不要用于**: 访客已到现场的边走边讲 —— 请用 skill `lab-tour-run`。
---
## ClassmateOS 新栈执行约定（M1）

本节覆盖下文遗留的飞书平台调用说明；旧业务工具和 Temi 工具名称暂时保留。
- 平台数据仅用 cos_table、cos_doc、cos_calendar、cos_task、cos_im、cos_drive、cos_contact、cos_notify、cos_search；不调用旧平台插件。
- 先 cos_table(action=list_tables)，再 get_table 获取 table_key 和真实字段；旧 data_layout 中的飞书 app_token/table_id 不能当 ClassmateOS 标识使用。
- 记录动作映射：list→list_records，create→create_records，update→update_records；参数用 table_key；新增 records=[{字段名:值}]，更新 records=[{record_id,fields:{字段名:值}}]。字段用 get_table/add_field/update_field；视图用 list_views/create_view。
- 文档用 cos_doc(action=list/get/create/update/append)，搜索用 cos_search(query=关键词)。用户上传的普通文件不等于云文档，不能直接把文件 ID 传给 cos_doc。
- 知识库目录移动、Wiki 和未实现视图功能暂不可用；可以创建独立云文档，但必须如实告知未归档到目标目录。
- 收集信息和确认先用普通对话等待用户回复；M1 尚无可信确认卡片，删除默认被服务端禁用，不得绕过。
- 调用以当前消息发送人权限执行；遇到无权访问应停止，不借用其他同学身份。



# 导览 · 准备期

## 最短路径

1. `feishu_classmate_data_layout()` → 取 `plugin_docs.publicProjects`，并**优先访问【知识库-公共协作区-导览母版】目录查找导览母版文件**。
2. 若在知识库未找到导览母版，再尝试读取配置项 `plugin_docs.tourTemplate` 或环境变量 `FEISHU_DOC_TOUR_TEMPLATE`，或向用户说明需提供母版链接/token。
3. 用 **openclaw-lark** 的 `cos_doc（action=get）` / `cos_search` 从【知识库-公共协作区-导览母版】读取母版全文。
4. **访客信息个性化处理**：
   - 从用户输入中提取访客单位/公司名称、人员身份等信息
   - 提取访客国别/主要语言；若判断为外国来宾，启用双语导览模式（中文 + 访客国家语言）
   - 若识别到具体公司名称，调用 `web_search` 工具搜索以下信息：
     ✅ 公司主营业务、所属行业赛道
     ✅ 核心技术方向、产品布局
     ✅ 近期融资/合作/发布动态
     ✅ 与实验室研究方向的契合点、潜在合作可能性
   - 分析访客兴趣侧重（如技术交流/投资考察/人才招聘/产学研合作等）
5. **生成定制化大纲与路线**：基于访客兴趣分析结果，在[**doc-format**](./references/doc-format.md)的基础上调整章节权重与导览路线顺序，对与访客匹配度高的展区优先到访并重点展开，相关性低的内容简化或后置
6. 结合母版内容、公共项目信息、访客个性化大纲，输出结构化 Markdown 导览稿（章节顺序即执行路线，`lab-tour-run`会按文档顺序逐章执行）；若为外国来宾，正文按“双语块”输出（中文在前，访客国家语言在后）。
7. **openclaw-lark** `cos_doc（action=create）`(或等价) 新建 Doc，**存储到【知识库-公共协作区-导览母版】目录下**，标题建议:`{日期}-{访客简称}-导览`。
8. 回复用户:**新 Doc 链接**、建议的**现场唤醒句**(写入 doc 末尾「唤醒」一节),并提示执行现场导览时调用 skill **`lab-tour-run`** 并传入该 `document_id`/链接。

## 详细步骤与占位符

见 [references/prepare-detail.md](./references/prepare-detail.md)。

## 降级

- 母版读失败 → 仅用 `labInfo` + `publicProjects` 摘要生成短篇 Doc,仍保存为新文档。
- 公司信息搜索失败/无有效结果 → 忽略个性化步骤，按通用模板生成导览稿，不影响整体流程。
- 无法识别访客单位信息 → 生成通用版导览稿。
- 无法确认外国来宾的国家语言 → 先向用户确认；若用户未回复且需立即交付，临时降级为“中文+英文”双语稿并在文档开头标注待确认。
