
## ClassmateOS 新栈执行约定（M1）

本节覆盖下文遗留的飞书平台调用说明；旧业务工具和 Temi 工具名称暂时保留。
- 平台数据仅用 cos_table、cos_doc、cos_calendar、cos_task、cos_im、cos_drive、cos_contact、cos_notify、cos_search；不调用旧平台插件。
- 先 cos_table(action=list_tables)，再 get_table 获取 table_key 和真实字段；旧 data_layout 中的飞书 app_token/table_id 不能当 ClassmateOS 标识使用。
- 记录动作映射：list→list_records，create→create_records，update→update_records；参数用 table_key；新增 records=[{字段名:值}]，更新 records=[{record_id,fields:{字段名:值}}]。字段用 get_table/add_field/update_field；视图用 list_views/create_view。
- 文档用 cos_doc(action=list/get/create/update/append)，搜索用 cos_search(query=关键词)。用户上传的普通文件不等于云文档，不能直接把文件 ID 传给 cos_doc。
- 知识库目录移动、Wiki 和未实现视图功能暂不可用；可以创建独立云文档，但必须如实告知未归档到目标目录。
- 收集信息和确认先用普通对话等待用户回复；M1 尚无可信确认卡片，删除默认被服务端禁用，不得绕过。
- 调用以当前消息发送人权限执行；遇到无权访问应停止，不借用其他同学身份。

# temi-connector

> 用自然语言控制 Temi 机器人（中文 → SDK 命令 → 执行）

---

## 工具

使用 `feishu_classmate_temi_control` 工具：
```
instruction: 自然语言指令
```

---

## ✅ 已实现的指令（sidecar v2 — 全部可正常使用）

### 🗣️ 说话 / 提问
| 指令 | 说明 | 底层端点 |
|------|------|---------|
| `说 XXX` | TTS 朗读文字 | `POST /speak` |
| `告诉 XXX` | 同「说」 | `POST /speak` |
| `问 XXX` | 提问并等待用户回答 | `POST /ask` |

### 🚶 导航
| 指令 | 说明 | 底层端点 |
|------|------|---------|
| `去 XXX` | 导航到指定地点 | `POST /goto` |

**支持地点**：入口、充电桩、工位区、会议室、实验室、生活仿真区、硬件台

### 🔄 旋转
| 指令 | 说明 | 底层端点 |
|------|------|---------|
| `左转` | 向左转 90° | `POST /turn` |
| `右转` | 向右转 90° | `POST /turn` |
| `转一圈` | 原地旋转 360° | `POST /turn` |
| `左转 N 度` | 向左转 N 度 | `POST /turn` |

### 🏋️ 倾斜（抬头/低头）
| 指令 | 说明 | 底层端点 |
|------|------|---------|
| `抬头` | 向上倾斜 15° | `POST /tilt` |
| `低头` | 向下倾斜 15° | `POST /tilt` |
| `抬头 N 度` | 向上倾斜 N 度（最大 55°） | `POST /tilt` |

### 🛞 全方向移动
| 指令 | 说明 | 底层端点 |
|------|------|---------|
| `前进` | 向前移动 | `POST /move` |
| `后退` | 向后移动 | `POST /move` |
| `向左` | 向左横移 | `POST /move` |
| `向右` | 向右横移 | `POST /move` |

### ⛑️ 停止
| 指令 | 说明 | 底层端点 |
|------|------|---------|
| `停下` / `停止` / `别动` | 紧急停止 | `POST /stop` |

### 📣 唤醒
| 指令 | 说明 | 底层端点 |
|------|------|---------|
| `唤醒` | 从睡眠唤醒 Temi | `POST /wakeup` |

### 👤 跟随
| 指令 | 说明 | 底层端点 |
|------|------|---------|
| `跟着我` | 启动跟随模式 | `POST /follow-start` |
| `停止跟随` | 退出跟随模式 | `POST /follow-stop` |

### 🔍 人员检测
| 指令 | 说明 | 底层端点 |
|------|------|---------|
| `打开检测` | 开启人员检测 | `POST /detection-start` |
| `关闭检测` | 关闭人员检测 | `POST /detection-stop` |

### 📷 拍照
| 指令 | 说明 | 底层端点 |
|------|------|---------|
| `拍照` / `拍张照` | 拍摄照片 | `POST /speak`（模拟） |

### 📍 位置管理
| 指令 | 说明 | 底层端点 |
|------|------|---------|
| `记住这里，叫 XXX` | 保存当前位置为 XXX | `POST /save-location` |
| `删除位置 XXX` | 删除已保存的 XXX | `POST /delete-location` |

### 🔋 状态查询
| 指令 | 说明 | 底层端点 |
|------|------|---------|
| `电量` / `状态` | 查询电量和位置 | `GET /status` |

---

## 🔜 Phase-2 暂未实现

| 指令 | 原因 |
|------|------|
| RFID 扫描 | 需硬件支持 |
| 表情手势（encourage/poke/applause/nod） | stub 已就绪，硬件未集成 |
| 拍照（真实图片返回） | 需 vision pipeline |

---

## 调用链

```
用户："转一圈"
  ↓
NLP 解析（nlp.ts → action: "turn", params: {degrees: 360}）
  ↓
HTTP POST http://127.0.0.1:8091/turn
  ↓
Python sidecar（server.py → turnBy(360, 0.5)）
  ↓ WebSocket
Temi 机器人执行旋转
```

---

## 文件索引

| 文件 | 说明 |
|------|------|
| `src/tools/temi/nlp.ts` | 自然语言解析（TemiNLP） |
| `src/tools/temi/control.ts` | 工具实现（自然语言 → HTTP） |
| `src/tools/temi/client.ts` | HTTP 客户端 |
| `temi-sidecar/server.py` | Python FastAPI sidecar（新增端点） |
| `temi-sidecar/adapters/temi.py` | WebSocket 适配器（新增方法） |
| `skills/temi-connector/` | 原始 skill 备份 |
