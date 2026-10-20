# 执行期 · 阶段与安全

## 与当次 Doc 的映射

### 动作指令解析规则
执行器会自动识别章节内容中的`【动作：XXX】`指令，支持以下指令的自动转换：
| 动作指令 | 对应Temi操作 |
|----------|----------------|
| `【动作：导航到 XXX】` | 调用`feishu_classmate_temi_control({instruction: "去 XXX"})`，导航到指定点位，等待导航完成后再执行下一步 |
| `【动作：抬头 N 度】` | 调用`feishu_classmate_temi_control({instruction: "抬头 N 度"})` |
| `【动作：左转 N 度】`/`【动作：右转 N 度】` | 调用`feishu_classmate_temi_control({instruction: "左转 N 度"})` |
| `【动作：等待】` | 暂停执行，等待用户说「继续」后再执行下一步 |
| `【动作：停止】` | 终止整个导览流程 |

### 章节执行逻辑
| Doc 章节 | 执行逻辑 |
|----------|----------------|
| 开场 | 解析章节内的动作指令依次执行 → 朗读讲解内容 |
| 实验室概况 | 解析动作指令（如有） → 朗读讲解内容 |
| 特色实验区 | 解析动作指令依次执行（通常是导航到对应点位） → 朗读讲解内容 + 补充`labInfo.specialAreas`中的点位介绍 |
| 工位区 | 解析动作指令（通常是导航到工位区） → 执行人员检测 → 朗读讲解内容 + 动态补充公开项目信息 |
| 人形机器人展区 | 解析动作指令（导航到对应点位） → 朗读讲解内容 |
| 仿真与生活模拟区 | 解析动作指令（导航到对应点位） → 朗读讲解内容 |
| 收尾与问答 | 解析动作指令（通常是回到入口） → 朗读邀请提问内容 → 进入问答模式 |
| 唤醒 | 执行期**不朗读**;仅作准备期约定的触发句备案 |

### 时序控制规则
- 所有动作指令按顺序同步执行，前一个动作执行完成后才会执行下一个动作
- 导航动作会等待机器人到达目标点位并静止后，再执行后续动作
- 所有动作执行完成后，才会开始朗读讲解内容
- 讲解内容朗读完成后，才会进入下一个章节的执行

无 Doc 时:按 [**fallback-generic-tour**](../../conduct-lab-tour/references/fallback-generic-tour.md) 五阶段执行。

## 工位区 bitable(公开项目)

- `cos_table` `action=list_records`, table_key 由 cos_table(action=list_tables) 查询
- `filter` 示例:`AND(CurrentValue.[owner_open_id]=[{id:"<ou_xxx>"}],CurrentValue.[visibility]="可公开")`
- 仅将 **title** 用于口播,**不要**在飞书消息中暴露 `open_id` 原文

## 问答

- 知识来源:当次 Doc + publicProjects Doc + `labInfo`
- 结束语:用户说「谢谢/结束/bye」或轮次上限后 `speak` 告别

## 安全

- 不透露保密项目;`feishu_classmate_temi_stop` 见主 SKILL

## 事后(可选)

- 摘要写入 `plugin_docs.dailyRecord` / `dailyRecordShortTerm` 对应日常记录 Doc
