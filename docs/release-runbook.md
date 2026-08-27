# Kisaki 发布与回滚手册

最后更新：2026-08-27

## 候选版

1. 冻结功能，更新 `CHANGELOG.md`，使用 `npm run bump -- <version>` 同步版本。
2. 执行前端测试与构建、Rust 测试、严格 Clippy、桌面 release 编译。
3. 确认 `characters/release-allowlist.json` 包含所有要随版本分发的角色 `id`（无需许可材料）。
4. 执行 `npm run release:preflight -- v<version>`；预检通过后创建 RC 提交，不推正式 tag。
5. 在三平台生成未签名 RC，按 `docs/rc-test-matrix.md` 验收并观察 7–14 天。

## 正式发布（签名工作最后执行）

1. 冻结最终提交，确认 CI、RC 缺陷和许可门禁全部通过。
2. 配置 Windows 代码签名、Apple Developer ID/公证，以及独立保管的 Tauri updater 私钥。
3. 从冻结提交创建 `v<version>` tag。CI 构建、签名并上传安装包、更新载荷、角色包、`latest.json` 和 `SHA256SUMS.txt`。
4. 执行 `npm run release:verify -- v<version>` 验证线上产物引用完整。
5. 在干净机器下载线上最终二进制，重跑安装、启动、自动更新、病毒扫描和数据保留场景。
6. 确认 GitHub Release 说明包含支持平台、已知限制、隐私说明和校验文件，再对外公告。

## 回滚

### 尚未被客户端采用

将错误 Release 标记为 draft 或删除 `latest.json` 资产，停止新的自动更新；不要复用或移动已发布 tag。

### 已有客户端开始更新

1. 立即停止公告，保存失败日志和原始资产，不覆盖证据。
2. 从最后一个已验证提交提高补丁版本，重新构建和签名；不要用旧版本号覆盖二进制。
3. 发布新的 `latest.json` 指向修复版本，并在发布说明中明确受影响版本与恢复步骤。
4. 若涉及数据损坏，先停止自动更新，提供经过验证的备份恢复流程，再恢复分发。
5. 若涉及密钥泄露，撤销系统签名证书，轮换 updater 密钥，并通过独立可信渠道通知用户。旧客户端无法信任新 updater 公钥时，必须提供手动安装迁移路径。

## 发布后记录

保存 tag、提交哈希、CI 运行链接、各平台签名身份、校验文件、RC 表、已知问题和回滚决定。密钥与密码不进入仓库、日志或发布附件。
