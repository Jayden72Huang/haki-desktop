# Haki macOS 发布指南(Apple Silicon + Intel 通用包,签名 + 公证)

目标:用户从 GitHub Release 下载 `Haki_<版本>_universal.dmg`,拖进 Applications 直接打开,
不出现「无法验证开发者」/「已损坏」提示。

## 一次性准备(只有账号持有人能做,约 10 分钟)

Team ID:`2X3MVMZTR2`(Xiliu Technology (Shenzhen) Co., Ltd.,付费 Developer Program)。
Developer ID Application 证书已于 2026-09-08 通过 Xcode → Settings → Accounts → Manage Certificates → + 生成并在 keychain 中,有效期至 2027-02-01。
下面第 1 步仅在换机器 / 证书过期时需要;最省事的方式是直接在 Xcode 里再点一次 + → Developer ID Application。

### 1. 申请 Developer ID Application 证书

CSR 已生成好:`output/signing/haki-devid.csr`(私钥 `haki-devid.key` 在同目录,已 gitignore,不要删)。

1. 打开 <https://developer.apple.com/account/resources/certificates/add>(须 Account Holder 身份登录)
2. 选 **Developer ID Application** → Continue → Profile Type 选 **G2 Sub-CA (Xcode 11.4.1 or later)**
3. 上传 `output/signing/haki-devid.csr` → Continue → Download,得到 `developerID_application.cer`
4. 回到终端导入(会同时生成 CI 用的 `.p12`):

   ```bash
   scripts/macos/import-devid-cert.sh ~/Downloads/developerID_application.cer
   ```

   看到 `Developer ID Application: Xiliu Technology (Shenzhen) Co., Ltd. (2X3MVMZTR2)` 即成功。

> ⚠️ **历史坑(2026-09-08)**:本机 Xcode 原先登录的两个团队 `687CTJPJXS` / `T8C9DHMA92` 都是免费 Personal Team,
> 申请 Developer ID 被 Apple 拒绝(`resultCode 4100: The selected team does not have a program membership that is eligible`)。
> 后来在 Xcode 登录了付费团队 `2X3MVMZTR2` 才解决。Apple Developer **Enterprise** Program 同样不能签发 Developer ID,
> macOS 对外分发必须用 Apple Developer Program(个人/组织)。

### 2. 公证凭据

当前生产发布脚本使用专属于 Haki 的钥匙串 profile `haki-notary`，不依赖 Xcode 账号会话猜测。由账号持有人交互保存：

```bash
xcrun notarytool store-credentials haki-notary --team-id 2X3MVMZTR2
```

Apple ID 与 App 专用密码只在安全提示中填写，不放进仓库或聊天。配置后用 `xcrun notarytool history --keychain-profile haki-notary` 检查。

## 本机出包

```bash
scripts/macos/release.sh                 # 构建 universal → 签名 → 公证 → 装订 → spctl 校验
scripts/macos/release.sh --skip-notarize # 只签名(快速自测)
scripts/macos/release.sh --adhoc         # 无证书时的自测包(用户机器上会被拦)
scripts/macos/release.sh --skip-build    # 复用上次构建产物重跑签名/公证
```

产物在 `output/release/`:
- `Haki_<版本>_universal.dmg` —— 分发给用户的文件
- `Haki_<版本>_universal.app.zip` —— 备用
- `SHA256SUMS-<版本>.txt`、`notary-<版本>.log`

脚本分别公证并装订 app 和最终 DMG，严格执行 app 的 execute assessment 与 DMG 的 primary-signature open assessment。任一步失败就停止，只有 `accepted` 和 `source=Notarized Developer ID` 才是可分发产物。使用 `HAKI_RELEASE_OUT_DIR` 指定独立产物目录；不会覆盖已有同名 DMG。

## CI 模板（尚未在本次发布启用）

本地工作流模板为 `.github/workflows/release-macos.yml`，启用前须提交并配置下列 Secrets；模板存在不代表远端 CI 已开通。本次采用本机公证后上传 Release，避免未配置的 tag 工作流误发布。

| Secret | 值 |
|---|---|
| `APPLE_CERTIFICATE` | `base64 -i output/signing/haki-devid.p12 \| pbcopy` |
| `APPLE_CERTIFICATE_PASSWORD` | 导入脚本第二个参数(默认 `haki`) |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: Xiliu Technology (Shenzhen) Co., Ltd. (2X3MVMZTR2)` |
| `APPLE_TEAM_ID` | `2X3MVMZTR2` |
| `APPLE_API_KEY_ID` | API Key ID |
| `APPLE_API_ISSUER` | Issuer ID |
| `APPLE_API_KEY_P8` | `.p8` 文件全文 |

然后:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

Release 页面会挂上 dmg / zip / SHA256SUMS。

## 技术要点

- `tauri.conf.json` → `bundle.macOS`:`hardenedRuntime: true`、`entitlements: Entitlements.plist`、`minimumSystemVersion: 11.0`
- `Entitlements.plist`:`allow-jit`(WKWebView)、`disable-library-validation`、`automation.apple-events`(osascript 跳终端)、`network.client`;**不开 App Sandbox**,因为要读 `~/.claude`、`~/.codex` 并调用 CLI
- `Info.plist` 会被 Tauri 自动合并,含 `NSAppleEventsUsageDescription`
- 通用包:`--target universal-apple-darwin`,Tauri 用 `lipo` 合并两架构;脚本会断言二进制同时含 `arm64` 和 `x86_64`
- 公证要求:Developer ID 签名 + Hardened Runtime + 安全时间戳(`--timestamp`),三者脚本都已带上
