# Claude 额度接入（Haki 修复候选，尚未公开发布）

Haki 的 Token 用量直接读取本机 CLI 日志，不需要配置本项。本项仅用于可选的 Claude 5 小时／7 天额度卡。

Claude Code 官方 status line 的输入提供 `rate_limits.five_hour`／`seven_day`。这些字段只在支持的订阅账号、首次 API 响应之后出现，每个窗口可以独立缺失。API Key 或自定义供应商不保证提供额度百分比。Haki 不通过额外模型请求探测剩余额度，不读取 VibeUsage 数据。

参考：[Claude Code 官方 status line 文档](https://code.claude.com/docs/en/statusline)。

## 没有现有 status line

安装支持此功能的 Haki 版本后，在 Claude Code 中使用 `/statusline`，要求其运行：

```text
"/Applications/Haki.app/Contents/MacOS/Haki" --capture-claude-quota
```

这条命令读取 Claude 传入的 JSON，只保存额度窗口、百分比、重置时间与本次捕获时间到 `~/.haki/claude-quota.json`（文件权限 0600），不保存整个 JSON。命令不输出状态栏文字；需要保留文字时采用下一节的包装方式。

## 已有 status line

保留现有配置和脚本。让现有脚本读取 stdin 后，把同一份输入额外传给 Haki，再继续原有渲染逻辑。例如 Bash 脚本的开头可使用：

```bash
input=$(cat)
printf '%s' "$input" | "/Applications/Haki.app/Contents/MacOS/Haki" --capture-claude-quota >/dev/null 2>&1 || true
# 下方原有渲染逻辑继续从 $input 读取 JSON；不要再次 cat stdin。
```

Haki 不会自动编辑 Claude 配置、覆盖原有 status line 或更改账号凭据。修改脚本前自行保存原件；若 Haki 安装位置不同，应使用实际 App 内的二进制绝对路径。

## 检查

1. 在 Claude Code 中正常完成一次请求。
2. 在 Haki 的用量视图点刷新，检查 Claude 额度卡与快照时间。
3. “尚未接入”表示尚未收到捕获；“尚未提供此额度窗口”表示捕获已接通但 Claude 没有返回该字段；过期窗口显示过期，不显示为 0%。

该流程本身不会绑定 HackerTrip 账号，也不会上传供应商 OAuth 令牌、对话或配置。官网同步仍使用独立的 HackerTrip 桌面设备授权。
