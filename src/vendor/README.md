# vendor/ — 官方（社区）插件收录区

本目录收录来自 [pi 包目录](https://pi.dev/packages) 的第三方插件**源码副本**，替代同功能的自研扩展。

## 收录原则

- **License 合规**：仅收录 MIT/Apache-2.0 等宽松许可的包；每个包目录内保留其原始 `LICENSE` 与 `README.md`，不抹除作者信息、不改名。
- **出处可查**：每个包的名称/版本/上游仓库记录在下表（PROVENANCE），便于日后对齐官方更新。
- **原样收录**：默认不做魔改。如确需本地修改，在包内改动处加 `// [LOCAL]` 注释并在下表「本地改动」列登记。
- **安装方式**：`install.js` 把各包复制到 `~/.pi/agent/vendor/<包名>/`，对声明了运行时 `dependencies` 的包执行 `npm install --omit=dev`（pi 对本地路径包不会自动装依赖），并把本地路径注册进 `~/.pi/agent/settings.json` 的 `packages`（幂等）。

## PROVENANCE（出处清单）

| 目录 | npm 包 | 收录版本 | 上游仓库 | License | 替代的自研扩展 | 收录日期 | 本地改动 |
|---|---|---|---|---|---|---|---|
| pi-subagents | [pi-subagents](https://www.npmjs.com/package/pi-subagents) | 0.53.0 | [nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents) | MIT | explore-agent | 2026-08-22 | 无 |
| pi-btw | [pi-btw](https://www.npmjs.com/package/pi-btw) | 0.4.1 | [dbachelder/pi-btw](https://github.com/dbachelder/pi-btw) | MIT | btw | 2026-08-22 | 无 |
| pi-rtk-optimizer | [pi-rtk-optimizer](https://www.npmjs.com/package/pi-rtk-optimizer) | 0.9.0 | [MasuRii/pi-rtk-optimizer](https://github.com/MasuRii/pi-rtk-optimizer) | MIT | token-saver | 2026-08-22 | 无 |

## 对齐官方更新

```bash
npm view pi-subagents version        # 查上游最新版
npm pack pi-subagents@<新版>          # 下载 tarball
tar -xzf pi-subagents-<新版>.tgz      # 解出 package/
rsync -a --delete package/ src/vendor/pi-subagents/   # 覆盖（Windows 可用 robocopy /MIR）
```

更新后：在上表改版本号与日期 → `node install.js` → pi 内 `/reload` → 实测无回归后提交。

> 注意：收录版本是**固定版本**，不参与 `pi update --extensions`（那是 pi 原生 npm 包管理的语义）；本目录刻意选择源码入库换取可审查、可复现，代价是更新靠手动。

## 外部伴随物（不入库）

| 伴随物 | 服务于 | 安装位置 | 来源 |
|---|---|---|---|
| `rtk` 二进制 v0.45.0 | pi-rtk-optimizer 的命令改写（无它时自动旁路，仅输出压缩生效） | `%APPDATA%\npm\rtk.exe`（PATH 上） | [rtk-ai/rtk](https://github.com/rtk-ai/rtk)（Apache-2.0） |
