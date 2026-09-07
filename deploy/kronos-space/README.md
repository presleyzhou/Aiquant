---
title: AIQUANT Kronos Inference
emoji: 📈
colorFrom: yellow
colorTo: purple
sdk: docker
app_port: 7860
pinned: false
license: mit
---

# AIQUANT Kronos 推理服务

让线上（Vercel）站点也能出 Kronos K线预测。Vercel Serverless 有 225MB 打包上限装不下
torch，所以推理跑在这个独立服务里，Vercel 后端检测到本地没有 torch 时会把
`/api/kronos/*` 请求服务器侧转发过来（浏览器无感知、无 CORS 问题）。

镜像内容：本仓库同一套 FastAPI 后端 + CPU 版 torch + 预先烤入镜像的
Kronos-small checkpoint（约 100MB，构建时下载，冷启动不再拉权重）。

## 部署到 HuggingFace Spaces（免费 CPU，推荐）

1. 注册/登录 huggingface.co，New Space → SDK 选 **Docker**，硬件选免费 CPU。
2. 把本目录的 `Dockerfile` 和这个 `README.md`（顶部的 YAML 头必须保留）上传到
   Space 仓库根目录。
3. 等构建完成，记下地址，形如 `https://<user>-<space>.hf.space`。
4. 验证：`curl https://<user>-<space>.hf.space/api/kronos/status` 应返回
   `"enabled": true`。
5. 在 Vercel 项目 → Settings → Environment Variables 添加
   `KRONOS_REMOTE_URL=https://<user>-<space>.hf.space`，Redeploy。
   线上 Kronos 面板即刻可用。

免费 CPU（2 vCPU）上一次 30 天预测约 5–15 秒；Space 闲置会休眠，
唤醒首个请求会多等几十秒（代理侧超时已放宽到 120 秒）。

## 部署到 Fly.io / Railway / 任意 Docker 主机

同一个 Dockerfile 直接可用（服务读 `$PORT`，默认 7860）：

```bash
fly launch --dockerfile deploy/kronos-space/Dockerfile
```

然后同样在 Vercel 配 `KRONOS_REMOTE_URL` 即可。

## 本地试跑镜像

```bash
docker build -t kronos-svc deploy/kronos-space
docker run -p 7860:7860 kronos-svc
curl -X POST localhost:7860/api/kronos/forecast \
  -H 'Content-Type: application/json' -d '{"symbol":"BTC-USD"}'
```

## 更新代码 / Updating the code

容器启动时会 `git pull` 最新的 `main`，所以后端代码更新后只需在 Space 页面点 **Restart**（Settings → Restart this Space）；
只有依赖变化（requirements 变了）才需要 **Factory rebuild**。如果 Factory rebuild 后仍是旧代码，说明构建复用了缓存层：
把 Dockerfile 里的 `ARG CACHE_BUST=...` 改成任意新值再 rebuild 一次。

The container `git pull`s `main` on every start, so a plain **Restart** picks up backend changes; a **Factory rebuild** is
only needed when requirements change. If a rebuild still serves old code, the builder reused a cached layer — change
`ARG CACHE_BUST=...` to any new value and rebuild once.
