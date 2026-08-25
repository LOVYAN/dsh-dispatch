# 自建 ntfy（可选，默认不用）

默认走 **ntfy.sh 公共服务**（`ntfyServerUrl: http://ntfy.sh`）。只有你不想把通知主题放在公网、并且能从 GitHub 下到官方 Windows 包时，才自建。

1. 从 https://github.com/binwiederhier/ntfy/releases 下载 `ntfy_*_windows_x86_64.zip`，放到本仓库 `ntfy/`（该目录已 gitignore 压缩包）。
2. 运行 `pwsh -File setup-ntfy.ps1`。
3. 把 `cordis.patch.yml` 里 `ntfyServerUrl` 改成脚本打印的地址（一般是 `http://127.0.0.1:2586`），手机订阅改为经 Tailscale 反代后的 URL。
4. 重启 DeepSeek Harness。

大多数人跳过本页即可。
