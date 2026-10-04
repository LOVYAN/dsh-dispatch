# dsh-voice-gateway

独立运行在 `127.0.0.1:3091` 的豆包 SeedDuplex STS 语音网关。它是 DeepSeek Harness 的耳朵和嘴巴；真正执行任务、工具、文件、浏览器、MCP 与子代理的仍是 Harness。

## 配置

配置只保存在本机 `$DSH_HOME/dsh-voice.json`，不会写入仓库。最低配置通常只需：

```json
{
  "apiKey": "<YOUR_API_KEY>"
}
```

完整模板见 `dsh-voice.example.json`。部分火山账号可能还要求 `appId` 或 `resourceId`，连接测试提示缺少时再填写。

同时需要 `$DSH_HOME/dsh-dispatch.json`，其中的 token 由 dsh-dispatch 插件生成，语音网关会自动读取。

## 单独启动

从仓库根目录运行：

```powershell
pwsh -File start-voice.ps1
```

安装器会把运行副本放到：

```text
$DSH_HOME/services/dsh-voice-gateway
```

语音网关保持独立进程，不嵌入 dsh-dispatch。

仓库启动脚本要求明确设置 `DSH_HOME`（或传入 `-DshHome`），避免误用旧数据。仅直接运行网关Node入口时，配置模块才在未设置环境变量时回退到用户主目录下的 `.dsh-home`。账号、token 和会话记录从选定目录读取，不需要仓库内的测试配置。

## 提交与结果语义

- 只有收到派单端接收确认后才播报“已经交给电脑”；接收确认不等于任务完成。
- 新任务携带不可变的 `requestId`。超时、冲突或断连时不自动重试、不生成新编号重发；先核查原请求和会话。内部操作对象保留原始请求身份以供显式核对。
- 根据会话结果的 `sessionId`、递增 `sourceSeq` 和 `isError` 区分错误、普通回复和未知结果。普通回复只表示本轮有回复，不保证用户目标全部完成；缺失或过期结果不使用旧页面文字冒充成功。
- 挂断只停止本地结果等待，不取消已接收的 Harness 任务；语音与任务执行保持独立。语音合成错误也不能证明任务未提交。
- 历史分页沿用同一 `historyToken`，校验会话、游标及固定读取边界；异常不自动开启另一个快照。

需要与支持这些派单接收、结果记录和历史快照协议的 dsh-dispatch 版本配套使用。

## 离线测试

运行环境需要 Node.js 22 或更新版本。网关运行依赖 `ws`（`^8.18.3`）；以下合成测试只依赖 Node 内置模块，不需要安装依赖，也不会启动服务、连接真实派单端或语音供应商。

在 `voice-gateway` 目录执行：

```powershell
node --test test/*.test.mjs
```

测试使用模拟网络响应与临时配置目录，不读取实际账号配置。

## 安全

- 不要提交 `$DSH_HOME/dsh-voice.json` 或 `dsh-dispatch.json`。
- 不要把含 token 的手机 URL 发到公开 issue。
- 服务默认只监听回环地址；手机访问建议使用 Tailscale Serve HTTPS。
- 语音不能批准权限，审批必须在 Harness UI 中点击。
