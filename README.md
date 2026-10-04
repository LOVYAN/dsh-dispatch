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

最低配置：**DeepSeek Harness 0.2.0-rc.2 + Node.js 22或更新版本 + PC/手机同一 Tailscale 账号 + 系统浏览器**。

## rc2 兼容更新

本分支面向 **DSH 0.2.0-rc.2**，不再假定 rc6 的旧版进程内 API。安装前备份自己的 DSH home，并明确指定当前正在使用的 `DSH_HOME`；不要把旧 home 或迁移测试 home 当作新版运行目录。

- 使用新版会话控制器、共享事件流和审批提交回执。提交收到不等于审批已经胜出。
- 手机历史支持固定快照的“更早记录／返回最新记录”；快照过期时给出恢复入口，不悄悄重置。
- 已记录的命令与回复单独标为只读历史，不冒充助手消息，也不会重新执行。无法确定的队列/内部事件仍明确标记为部分投影，不声称完整还原所有运行痕迹。
- 派单保留请求标识；网络结果不确定时不自动重发，避免重复任务。
- 独立语音保持独立进程；收到派单确认后再播报，挂断不等于取消远端任务，助手产生回复不等于目标已完成。

本仓库仅包含可移植源码、测试和模板，不包含个人对话、账号、浏览器资料或本机迁移备份。

## 安装（Windows）

1. 本机已能打开 DeepSeek Harness Web（默认 `http://127.0.0.1:3080`）。
2. 克隆本仓库后任选一种：

   ```powershell
   # A. 官方入口（推荐，和识图插件同一套）
   dsh plugin --profile web add ./dsh-dispatch
   ```

   ```powershell
   # B. Windows安装器：明确指定正在使用的home，不自动猜旧目录
   $env:DSH_HOME = 'D:\path\to\your-dsh-home'
   pwsh -File install.ps1
   ```

3. 如需豆包语音，安装器会在配置不存在时生成模板；随后编辑本机 `$DSH_HOME/dsh-voice.json`。不要把真实密钥写进命令历史、仓库模板或提交记录。部分火山账号还需要 App ID/Resource ID，请按账号要求填写。只安装插件可用 `-SkipVoice`；显式离线复制可用 `-CopyOnly -SkipVoice`，不会在CLI失败后偷偷回退。
4. **重启** DeepSeek Harness，并运行 `pwsh -File start-voice.ps1` 启动独立 3091 网关。
5. 打开 `http://127.0.0.1:3080/dispatch/health` 和 `http://127.0.0.1:3091/health`，都应返回健康状态。
6. 从本机 `$DSH_HOME/dsh-dispatch.json` 读取首次运行生成的token和可选ntfy主题。用自己配置的Tailscale地址打开 `/dispatch/chat?token=…` 并加入书签；不要公开这个完整链接。
7. 重启后可执行 `pwsh -File verify.ps1 -DshHome $env:DSH_HOME -CheckVoice`，进行只读健康和鉴权检查，不自动创建任务。

首次启动把 token / 主题写到 `$DSH_HOME/dsh-dispatch.json`（不要提交）。安装器不会自动改动Tailscale路由；请自行将Web和独立语音服务映射到需要的HTTPS入口。

ntfy开关以宿主的**有效插件配置**为准：后加载的patch如果设为 `pushEnabled: false`，仅修改保存token的JSON不会开启通知。需要在对应patch恢复 `pushEnabled: true` 并重启宿主。测试阶段可禁用推送，正式使用前应显式核对；HTTP发布成功不等于手机已收到通知。

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
- 被跟踪的一轮结束 → 发送结果通知（可点【打开会话】）；通知中的完成措辞仅表示该轮结束，不是对业务目标达成的独立验证。

路由都在 `/dispatch/*`，**不走** `/api` 信任栅栏，token 就是鉴权。

针对 ntfy.sh 走 HTTP/80 时的中间盒：JSON 非 ASCII 转成 `\uXXXX`；`priority` 用数字 `4`/`5`，不要用字符串 `"high"`。

## 开发

改 `plugin/lib/index.js` 后：

```powershell
pwsh -File deploy.ps1
```

然后重启 DeepSeek Harness。`deploy.ps1` 只覆盖插件文件，不改 token。

兼容目标：DeepSeek Harness **0.2.0-rc.2**（新版会话控制器与宿主网关）。旧rc6用户不要直接覆盖安装本分支。插件根包和 `plugin/` 镜像必须一起更新；安装/部署需复制完整 `lib/`，不能只复制 `lib/index.js`。

本仓库不会发布某台电脑的进程PID、迁移目录或重启配置。宿主重启由你自己的服务管理器负责；部署脚本不能代替已验证的备份和重启流程。

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
