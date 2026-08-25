# 第三方安装包（不进 git）

GitHub **不能、也不该** 托管 Tailscale / ntfy 的安装文件：

- 体积大（几十到上百 MB），每次 clone 都受罪
- 许可证不允许再分发二进制（尤其 Tailscale）
- 签名和自动更新必须走官方通道，旁路商店/官网等于让对方装来路不明的包
- 手机 APK 还有各厂商应用商店条款

本目录只放**官方下载入口**。运行 `fetch-official.ps1` 会把安装包拉到 `vendor/downloads/`（已 gitignore）。

| 软件 | 官方入口 | 本脚本做什么 |
|---|---|---|
| Tailscale Windows | https://pkgs.tailscale.com/stable/tailscale-setup-latest-amd64.msi | 下载 MSI 到 `downloads/` |
| Tailscale Android | https://play.google.com/store/apps/details?id=com.tailscale.ipn 或 https://pkgs.tailscale.com/stable/#android | **打开浏览器**（APK 因商店条款不代下） |
| ntfy Android | https://ntfy.sh | 打开 Play / F-Droid / GitHub Releases 说明页 |
| ntfy Windows（仅自建服务端） | https://github.com/binwiederhier/ntfy/releases | 可选：打开 Releases，不要默认下载 |

用法：

```powershell
pwsh -File vendor/fetch-official.ps1
```

装好后回到仓库根目录跑 `install.ps1`。锁屏推送不需要 ntfy；会话页批权限即可。
