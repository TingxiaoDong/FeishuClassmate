# 进度检查指南

## 执行时间
每日14:00（中国时区，Asia/Shanghai）cron自动触发

## 核心目标
DDL当天主动提醒：先线下（temi）找人当面提醒，找不到再飞书私信兜底。

## 执行流程（按顺序）
1. 调用`feishu_classmate_data_layout()`读取`tables.gantt`、`bitable.appToken`等必要配置
2. 使用`cos_table`读取甘特表，筛选条件：
   - `due_date`是今天（按Asia/Shanghai日期）
   - `status`不为已完成
3. 将命中任务按负责人聚合：
   - 同一负责人当天只生成1条提醒
   - 同一负责人多项任务必须合并提醒内容（项目名+节点名+DDL）
4. 负责人字段支持多人：
   - 若任务有多个负责人，按“每位负责人”分别加入其提醒聚合结果
   - 逐个负责人执行后续“寻人与通知”
5. 对每位负责人执行线下优先提醒：
   - 在实验室预设点位循环调用`feishu_classmate_temi_navigate_to`
   - 每到一个点位调用`feishu_classmate_temi_detect_person`
   - 检测到open_id与当前负责人匹配后，调用`feishu_classmate_temi_speak`当面提醒并结束该负责人流程
6. 若走完整个点位仍未找到负责人：
   - 调用Lark消息能力发送私信（`im.v1.message.create`/等价封装工具）
   - 发送合并后的当日DDL提醒文本

## 线下寻人 Skill（新增，可复用）
用于“先到工位找人，再确认身份，再当面提醒”的标准动作链，按负责人逐个执行。

### 输入
- `owner_open_id`：负责人飞书 `open_id`
- `owner_name`：负责人姓名（用于话术）
- `task_digest`：该负责人当天DDL任务合并摘要
- `desk_route`：该同学工位路径（例如 `["工位区-A3","工位区-A4"]`）

### 精确接口（temi + 图像识别）
1. **连通性检查**  
   - 工具：`feishu_classmate_temi_status`  
   - 目标：确认 `ok=true` 且机器人可用；不可用则直接走飞书兜底。
2. **导航到工位/路径点**  
   - 工具：`feishu_classmate_temi_navigate_to`  
   - 参数：`{ "location": "<路径点>" }`  
   - 对应 sidecar 端点：`POST /goto`
3. **到点后做人脸/身份识别**  
   - 工具：`feishu_classmate_temi_detect_person`  
   - 参数：`{ "timeout_ms": 5000 }`（可在 `500~15000` 内调节）  
   - 对应 sidecar 端点：`POST /detect-person`  
   - 判定：返回 `open_id == owner_open_id` 视为找到本人。
4. **当面提醒**  
   - 工具：`feishu_classmate_temi_speak`  
   - 参数：`{ "text": "<帮扶提醒文案>", "voice": "friendly" }`  
   - 对应 sidecar 端点：`POST /speak`
5. **异常中断（可选）**  
   - 工具：`feishu_classmate_temi_stop`  
   - 参数：`{ "immediate": true }`  
   - 对应 sidecar 端点：`POST /stop`

### 执行规则
- `desk_route` 中的路径点按顺序遍历；任一路径点识别成功即停止继续导航。
- 若 `feishu_classmate_temi_detect_person` 在所有路径点都未匹配到 `owner_open_id`，判定“线下未找到”，进入飞书私信兜底。
- 同一负责人当天只执行一次本 Skill（任务已在上游合并）。
- 线下提醒成功后，不再发送飞书私信，避免重复打扰。

### 工位路径来源
- 优先使用实验室维护的“同学→工位点位”映射数据（可来自飞书表/配置）。
- 若无个人工位映射，使用默认巡检路径（如 `工位区-A1 → A2 → A3 ...`）执行寻人。

## 提醒去重与合并规则
- 同一负责人同一天只能提醒1次（无论其有多少任务）
- 当天同一负责人多项任务必须在同一条提醒里列出
- 若当面提醒已成功，禁止再发送飞书私信
- 若当面提醒失败，必须发送飞书私信作为兜底

## 飞书提醒文案模板（兜底私信）
> 【今日DDL温馨提醒】{负责人姓名}同学，辛苦啦～你今天有{任务数}项任务到期：{任务列表}。  
> 我刚刚在实验室找你时没碰到你，先在飞书给你留个小提醒，记得完成今日任务哦
> 如果你希望，我可以马上帮你一起拆分任务、梳理优先级，或协调所需资源，我们一起把今天的目标稳稳推进。

## 异常处理
- 甘特表读取失败：记录失败原因并结束本轮，不执行寻人
- 负责人字段为空：跳过该任务并记录数据异常
- temi不可用或导航失败：直接降级为飞书私信
- 飞书私信失败：记录日志，等待下一轮检查重试

