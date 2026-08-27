# dsh-voice-gateway

独立运行在 `127.0.0.1:3091` 的豆包 SeedDuplex STS 语音网关。它是 DeepSeek Harness 的耳朵和嘴巴；真正执行任务、工具、文件、浏览器、MCP 与子代理的仍是 Harness。

## 配置

配置只保存在本机 `$DSH_HOME/dsh-voice.json`，不会写入仓库。最低配置通常只需：

```json
{
  "apiKey": "你的火山 X-Api-Key"
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

## 安全

- 不要提交 `$DSH_HOME/dsh-voice.json` 或 `dsh-dispatch.json`。
- 不要把含 token 的手机 URL 发到公开 issue。
- 服务默认只监听回环地址；手机访问建议使用 Tailscale Serve HTTPS。
- 语音不能批准权限，审批必须在 Harness UI 中点击。
