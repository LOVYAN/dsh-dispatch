# 给 GitHub 的几步

本仓库**不要**提交：

- `.dsh-home/`、`cordis.patch.yml`
- `dist/*.zip`、`ntfy/*.tar.gz` / `ntfy.exe`、`vendor/downloads/`（官方安装包本地缓存）
- 任何含 token、主题名、`*.ts.net` 主机名的笔记

首次发布：

```powershell
cd path\to\dsh-dispatch
git init
git add LICENSE README.md CONTRIBUTING.md .gitignore plugin install.ps1 deploy.ps1 verify.ps1 pack.ps1 setup-ntfy.ps1 docs 分发说明.md
git status   # 确认没有 token、没有 ntfy tarball、没有 dist zip
git commit -m "Initial public release of dsh-dispatch"
git branch -M main
git remote add origin https://github.com/<you>/dsh-dispatch.git
git push -u origin main
```

建议仓库设为 **Public**，在 README 顶部说明需要 DeepSeek Harness 0.1.0-rc.6+ 与 Tailscale。Issues 里不要让别人贴他们的 token / 主题。
