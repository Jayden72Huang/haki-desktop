# HackerTrip 桌面助手

黑客松选手的桌面伴侣:比赛日程提醒、Agent 用量统计、参赛过程数据记录。
用真实的过程数据(token 用量、commit 记录、作品交付)反映一个人的 AI 协作能力。

## P0 功能清单

| # | 功能 | 说明 |
|---|------|------|
| 1 | 比赛倒计时与阶段提醒 | 提交截止倒计时;比赛时长按「立项→核心功能→打磨→提交材料」划分阶段,落后时提醒;截止前弹出提交材料清单 |
| 2 | Agent 用量统计 | Claude Code 5 小时/每周额度、重置时间、token 消耗;比赛中提示「额度将在截止前耗尽」 |
| 3 | Git 提交监控 | 参赛仓库长时间未 commit 时提醒(防止代码丢失);展示当日提交次数 |
| 4 | 赛事列表与报名提醒 | 新赛事通知;关注赛事后自动生成报名/组队/开赛/提交的提醒链 |
| 5 | AI 协作能力评估 | 基于真实数据(token 转化效率、工程习惯、参赛交付)计算能力评分,比赛结果为评分背书 |
| 6 | 赛后数据报告 | 比赛结束自动生成可分享的数据总结图(时长/commit/token/评分变化) |
| 0 | 账号与数据上报 | 扫小程序码登录;本地脱敏聚合,只上报统计特征,原始代码与对话内容不上传 |

## 目录结构

```
hackertrip-desktop/
├── app/                  # Tauri 2 桌面应用(vanilla-ts 前端 + Rust 后端)
│   ├── src/              # 悬浮窗前端(胶囊条 + 展开面板)
│   └── src-tauri/        # Rust:usage_today 命令解析 ~/.claude 日志
├── scripts/
│   └── claude-usage.mjs  # 数据层验证脚本:统计近 N 天 token/会话/费用
└── prototype/
    ├── floating-panel.html   # UI 风格原型(4 个状态)
    └── usage-summary.json    # 真实数据快照(脚本生成)
```

## 文档

- [使用说明书 MANUAL.md](./MANUAL.md) — 每个功能怎么用、首次配置清单、常见问题
- [功能迭代说明 ITERATION.md](./ITERATION.md) — 本次改了什么、技术取舍与踩过的坑

## 开发

```bash
# 数据层验证(独立运行,不依赖应用)
node scripts/claude-usage.mjs --days 30

# 桌面应用开发
cd app && npm install && npm run tauri dev
```

窗口为无边框、置顶、透明背景的悬浮条,按住任意非按钮区域可拖动,点击展开/收起。

## 发布(规划)

- 官网分发 DMG(不上 Mac App Store,沙盒会限制读取 `~/.claude` 与 git 仓库)
- 需要 Apple Developer 账户($99/年)做 Developer ID 签名 + notarization,否则 macOS 15+ 用户无法正常打开
- 自动更新走 Tauri updater(要求签名构建)
