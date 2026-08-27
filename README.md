# dsh-dispatch

DeepSeek Harness 的 **Cordis 插件**：用手机给本机 Agent 派任务、看回复、续聊、批权限。仓库根目录就是插件包（`lib/` + `cordis.patch.yml`）。`.ps1` 只是 Windows 安装器，不是产品本身。

不是再做一个聊天网页套壳。审批和会话走 DSH 进程内 API；手机只通过 Tailscale 访问本机 `/dispatch/*`。

## 你能得到什么

| 能力 | 怎么用 | 要不要 ntfy |
|---|---|---|
| 看回复 / 续聊 / 新开会话 | 手机浏览器打开 `/dispatch/chat?token=…` | 否 |
| 批准 / 拒绝提权 | 同一会话页顶上的横幅按钮 | 否 |
| 豆包实时语音对谈、读结果、确认后派单 | 独立 `voice-gateway/`，默认 3091 | 否 |
| 锁屏弹通知、点【批准】【拒绝】 | 手机装 ntfy，订阅安装脚本打印的主题 | 可选 |

最低配置：**电脑有 DSH + PC/手机同一 Tailscale 账号 + 系统浏览器**。

## 安装（Windows）

1. 本机已能打开 DeepSeek Harness Web（默认 `http://127.0.0.1:3080`）。
2. 克隆本仓库后任选一种：

   ```powershell
   # A. 官方入口（推荐，和识图插件同一套）
   dsh plugin --profile web add ./dsh-dispatch
   ```

   ```powershell
   # B. 还没有 dsh plugin 命令时
   pwsh -File install.ps1
   ```

3. 如需同时配置豆包语音，可直接传 API Key：

   ```powershell
   pwsh -File install.ps1 -VolcApiKey "你的 X-Api-Key"
   ```

   不传参数时安装器会安全提示输入；配置只写入 `$DSH_HOME/dsh-voice.json`。部分火山账号若要求 App ID/Resource ID，可用 `-VolcAppId`、`-VolcResourceId`，或安装后编辑本机配置。
4. **重启** DeepSeek Harness，并运行 `pwsh -File start-voice.ps1` 启动独立 3091 网关。
5. 打开 `http://127.0.0.1:3080/dispatch/health` 和 `http://127.0.0.1:3091/health`，都应返回健康状态。
5. 脚本结束时会打印：
   - 手机会话页 URL（含 token）
   - 可选的 ntfy 主题名  

   把会话页加到手机浏览器书签即可。

首次启动把 token / 主题写到 `$DSH_HOME/dsh-dispatch.json`（不要提交）。`install.ps1` 若检测到 Tailscale，会尝试开启 Serve。

**不要把 `dsh-dispatch.json` 或含 token 的 `cordis.patch.yml` 提交到 git。**

第三方安装包**不要**提交到 git（许可证、签名、体积）。克隆后可运行 `pwsh -File vendor/fetch-official.ps1` 从官方源拉 Tailscale Windows MSI，并打开手机端下载页。说明见 [vendor/README.md](vendor/README.md)。

## 手机

1. 安装 [Tailscale](https://tailscale.com/download/android)，登录和电脑**同一个账号**。电池 → 无限制，允许自启动。
2. 浏览器打开安装脚本打印的会话页。需要审批时页顶会出现【✅ 批准】【❌ 拒绝】。
3. （可选）再装 [ntfy](https://ntfy.sh)，订阅脚本打印的主题，服务器保持 `https://ntfy.sh`，打开该订阅的**即时传递**。锁屏才会主动弹。不装也能从会话页批权限。

详见 [docs/手机端配置指南.md](docs/手机端配置指南.md)。把本仓库发给别人见 [分发说明.md](分发说明.md)。

## 仓库结构

```
plugin/                 DSH Cordis 插件运行代码
voice-gateway/           独立豆包 SeedDuplex STS 网关源码
install.ps1             一键安装插件和语音网关
start-voice.ps1          启动本机独立 3091 服务
deploy.ps1              同步插件/语音源码，保留本机密钥
verify.ps1              重启后冒烟（health / 鉴权）
sync-github.ps1         脱敏检查后 commit/push
pack.ps1                打可分享 zip 到 dist/（不进 git）
docs/                   手机配置、快捷指令、设计笔记
```

## 工作原理

插件以进程内客户端连进 DSH 的 mux / host 流：

- `approval/requested` → 可选 ntfy 推送；会话页同时画审批横幅
- 手机点批准 → `/dispatch/decision` 或会话页 `?decide=` → `respond()` 注入决策  
  与网页 GUI 平级，先答先赢
- `POST /dispatch/task` 或会话页表单 → `sessions.create` + `sessions.prompt`
- 一轮结束 → 推「✅ 任务完成」（可点【打开会话】）

路由都在 `/dispatch/*`，**不走** `/api` 信任栅栏，token 就是鉴权。

针对 ntfy.sh 走 HTTP/80 时的中间盒：JSON 非 ASCII 转成 `\uXXXX`；`priority` 用数字 `4`/`5`，不要用字符串 `"high"`。

## 开发

改 `plugin/lib/index.js` 后：

```powershell
pwsh -File deploy.ps1
```

然后重启 DeepSeek Harness。`deploy.ps1` 只覆盖插件文件，不改 token。

要求：DeepSeek Harness **0.1.0-rc.6** 附近（`webServer` + `apiProxy` + `InProcessApiClient`）。

## 同步到 GitHub

在仓库根目录运行（Windows PowerShell 5 也可用）：

```powershell
powershell -ExecutionPolicy Bypass -File .\sync-github.ps1 -Message "feat: update voice gateway"
```

安装了 PowerShell 7 时也可以：

```powershell
pwsh -File .\sync-github.ps1 -Message "feat: update voice gateway"
```

只提交、不推送：

```powershell
powershell -ExecutionPolicy Bypass -File .\sync-github.ps1 -NoPush
```

脚本会在 `git add/commit/push` 前检查真实 API Key、token、私有 Tailscale 域名、本机绝对路径、日志和音频文件。

## 安全

- token 出现在会话页 URL 和 ntfy 动作链接里，等同口令。泄露后应轮换本机 `$DSH_HOME/dsh-dispatch.json` 中的 token 并重启。
- ntfy 公共主题靠随机名保密，不要把主题发到公开 issue。
- Tailscale 把 3080 留在回环，手机走 `*.ts.net` HTTPS，不要把 3080 绑到公网。

## License

MIT
