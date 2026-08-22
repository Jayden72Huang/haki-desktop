# 功能迭代说明 · 2026-08-22

分支 `feat/race-mode-cli-assist`，两个 commit，改动 4 个文件约 1100 行。

本次围绕两条主线：**让选手在比赛里用得上**（参赛模式三条本地 CLI 链路），以及**让 agent 列表说人话**（session 条补齐字段）。

---

## 一、参赛模式（commit `fc2588e`）

目标是配合黑客松选手参赛，用本地 CLI 把「知道该做什么」「问得到答案」「交得出作品」三件事串起来。

### 1. 赛程节点规划

**改动前**：只能手填比赛名和起止时间，阶段条是写死的立项 15% / 核心功能 45% / 打磨 25% / 提交材料 15% 四段比例。

**改动后**：建比赛时多一个文档粘贴框，可贴主办方赛事文档或群公告。CLI 解析成带时间的节点，渲染成时间轴。

- 后端命令：`plan_hackathon(name, start, end, doc) -> JSON`
- 节点结构：`{ at, title, action, critical }`
- 文档里写明的时间**原样保留**，没写的才按经验推导
- `critical` 只给错过就无法挽回的硬节点（报名截止、提交截止、路演签到）

**提醒机制**：`critical` 节点提前 30 分钟推送，普通节点到点推送。已提醒的按 `at` 存 localStorage 去重，且只在跨过触发点的 2 分钟窗口内触发——否则开机会把所有过期节点一次性弹出来。

**实测**（AdventureX 群公告，11 个节点）：

```
🔴 08-25T09:00  开幕式签到        云栖小镇A馆凭身份证签到入场
🔴 08-25T10:30  赞助商Token发放    B馆二楼凭队伍编号领API Key
   08-25T14:00  选题与仓库定版     锁定题目技术栈，建GitHub仓库并推首次提交
🔴 08-26T12:00  中期checkpoint    飞书群提交进度截图，不交视为弃赛
   08-26T22:00  功能冻结          停止加新功能，只修bug与写README
🔴 08-27T15:00  作品提交截止       adventurex.io/submit提交仓库+演示视频
```

文档里的 5 个硬时间全部原样保留并标红，另外补出了「功能冻结」「演示视频定稿」「提交预演」等推导节点。

### 2. 赛事问答

窗口内输入框，把赛事文档 + 已解析节点作为上下文丢给本地 CLI，回答「赞助商 token 在哪领」「作品交到哪」这类现场问题。

- 后端命令：`ask_hackathon(question, name, doc, milestones)`
- 只在参赛模式出现，日常模式不显示
- 文档里没写的会明确说「文档里没写」，再给一句建议，不瞎编

### 3. 交作品

项目文件夹拖进窗口 → CLI 读 README / package.json / 最近 15 条 commit 提炼成作品卡片 → 可编辑表单确认 → 推到小程序待审核区。

- `extract_work(path)` 负责提炼，`push_work(...)` 负责上传
- 走 pairSync 云函数的 HTTP 触发器，与 `hackertrip-cli` 的 `publish-work` 是同一条链路
- 提交后作品状态为 `pending`，选手在小程序「我的 → 作品」确认后才公开

**实测**（拿本项目自己做输入）：

```
name:      HackerTrip 桌面助手              ← 不是目录名
summary:   macOS 悬浮窗桌面工具，解析本地 ~/.claude 日志与 git 记录…
repo:      https://github.com/Jayden72Huang/hackertrip-desktop
techStack: Tauri 2 / Rust / TypeScript / Node.js
```

### 4. 小红书

只做到**文案生成 + 自动复制 + 点击唤起创作页**，最后一步手动粘贴。

原因：小红书没有开放给第三方的发布 API（个人号尤其没有）。真要一键发只能走浏览器自动化（如本机的 xiaohongshu MCP），属于账号有风险的操作，本次没做。

---

## 二、session 条改造（commit `ca91aef`）

### 改动前的问题

一条 session 只显示「agent 名 + 目录名 + token 数」，最该被看到的**「这个会话在干什么」反而要展开才有**。并且所有 codex 行的状态永远是空白。

### 布局

主行放最重要的信息，次行放定位信息：

```
●  [logo]  给白皮书加宇航员行走动画           12 改动 +340/-28 › 
           hackertrip-miniprogram  ⑂ feat/discover-category-works
```

- CLI 名字换成 logo（Claude 星芒 / Codex 圆环 / Gemini），未知 agent 退回首字母方块
- 「改动」口径是 **git 未提交改动**：文件数 + 行级增删，与旁边的分支字段语义一致
- 设置里新增「Agent 列表显示字段」，任务概述 / 所在文件夹 / 分支 / 改动 / 耗时·tokens 五项各自可关，存 localStorage

### codex 空白的根因（两处，都已修）

1. `refreshAgents` 里写死了 `filter(a => a.agent === "claude")`，codex 压根没去查状态
2. `agent_status` 只读 `~/.claude/projects/`，而 codex 的会话在 `~/.codex/sessions/`

### codex 会话解析的取舍

这部分踩的坑值得记一下，后续要支持别的 agent 会遇到同样问题：

- **只读首行定位目录**：rollout 文件首行就是 `session_meta`，里面带 `cwd`。本机有 1087 个历史会话，全读一遍不可接受；按 mtime 倒序只在最近 300 个里找。
- **thread_name 不可靠**：任务概述优先取 `session_index.jsonl` 里的 `thread_name`，但实测发现**正在跑的会话往往还没有标题**（codex 是事后才给会话起名的）——而那恰恰是最需要显示任务的行。所以加了回退。
- **回退取首条而非末条用户指令**：首条是这个会话被派去做什么，末条常常是中途追问或系统回放，单独看不知所云。
- **必须过滤系统注入**：codex 会以 `role=user` 往对话里注入插件清单、AGENTS.md、历史回放。不过滤的话「任务」会显示成一坨配置文本。过滤规则见 `CODEX_NOISE_PREFIXES`。

修复后效果：

```
InFlow-X             → Third verification round on InFlow-X M3 security hardening…
hackertrip-recovery  → 检查一下云端小程序里面的数据库上线了哪些黑客松赛事！
AI自媒体工具          → Automation: 公众号长文质检并同步草稿箱
```

---

## 三、新增的后端命令

| 命令 | 作用 |
|---|---|
| `plan_hackathon` | 赛事文档 → 赛程节点 JSON |
| `ask_hackathon` | 带赛事上下文的问答 |
| `extract_work` | 项目目录 → 作品卡片 |
| `push_work` | 作品推到小程序待审核区 |
| `rate_limits` | 读 vibe-usage 落地的额度快照 |
| `agent_status` | **签名变更**：新增 `agent` 参数用于分派 claude / codex |

`run_claude()` 是这几条命令共用的 CLI 封装。

---

## 四、部署前必须知道的三个坑

这三个都是本次调试时踩出来的，改别的地方也容易再踩：

**1. 调 CLI 必须关掉 stdin**

`claude -p` 不给 stdin 会**傻等 3 秒**才放弃（stderr 会打 `no stdin data received in 3s`）。`run_claude` 里加了 `.stdin(Stdio::null())`，每次调用省 3 秒。

**2. git remote 的 SSH 形式会导致作品被拒**

小程序端 `pairSync` 用 `isHttpUrl` 硬校验链接，`git@github.com:owner/repo` 会被判成脏链接直接置空，作品因为缺链接被 `INVALID_WORK` 拒收。`remote_to_https()` 统一转换。

**3. 两套配对码不能混用**

- `request_pair_code` → 打到网站 `/api/pair/code`，是**网站账号 ↔ 小程序绑定**用的
- 交作品要用的是**小程序「我的 → Skills 同步」生成的 6 位码**，配合 `x-sync-token` 打到 pairSync 触发器

一开始接错成前者，作品数据根本没上传。

---

## 五、使用前需要配置

交作品功能要在**设置**里填两个值，否则点提交会提示缺配置：

| 配置项 | 从哪拿 |
|---|---|
| pairSync 触发器地址 | 腾讯云 pairSync 云函数的 HTTP 触发器 URL |
| 同步密钥 uploadToken | 小程序配对时生成 |

对应 `hackertrip-cli` 的 `HACKERTRIP_SYNC_URL` / `HACKERTRIP_SYNC_TOKEN` 两个环境变量。本机这两处都没配，CLI 也没有默认值，需要自行获取。

---

## 六、已知限制与未完成项

**未在真机验证**

- **拖拽提取**：`onDragDropEvent` 是窗口级 API，逻辑已完成但没跑过真实拖放。macOS 上偶尔需要窗口先获得焦点。
- **完整 UI 效果**：最后一次构建因**本机磁盘满**（`No space left on device`）中断，代码本身 `cargo check` 与 `npm run build` 均通过。接手时先确认磁盘空间。

**未开始**

- 「使用量」tab（原计划放在「指南」右边）。后端 `rate_limits` 已就绪，读 `~/.vibe-usage/{claude,codex}-rate-limits.json`，能直接还原 Codex 的「官方当前未启用」「Prolite」「重置券 ×1」「7d 60%」等状态，只差前端。
- 小红书真正的一键发布（见上文原因）。

**设计约束**

窗口是 660×380 无边框透明悬浮窗、`resizable: false`。新增的对话框和作品表单都是内嵌 toggle，靠 `fitWindow()` 按 `scrollHeight` 自适应高度（上限 620），没有另开窗口。后续加内容要注意这个高度上限。

---

## 七、验证方式

```bash
cd app
npm install
npm run tauri dev
```

启动后是**无边框透明悬浮窗，不进 Dock 任务栏**，在屏幕上找那个置顶的胶囊条，不要在 Dock 里找图标。

- 日常模式：看 session 条的任务概述、分支、改动是否正常
- 比赛模式：建一场比赛并粘贴任意赛事文档，看赛程节点能否排出
- 交作品：展开「交作品」，拖一个 git 项目文件夹进窗口
