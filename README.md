# 表达训练后端

这是表达训练 App 的 Node.js 后端。它支持两种模式：

- 未配置 Supabase：使用 `backend/data/db.json` 和 `backend/data/media/` 做本地开发兜底。
- 配置 Supabase：使用 Supabase PostgreSQL 保存账号和同步数据，使用 Supabase Storage 保存录音/视频。

## 本地启动

```powershell
node server.js
```

默认地址：

```text
http://127.0.0.1:8787
```

健康检查：

```text
http://127.0.0.1:8787/api/health
```

如果手机和电脑在同一个 Wi-Fi，App 里的后端地址不能填 `127.0.0.1`，要填电脑局域网 IP，例如：

```text
http://192.168.1.23:8787
```

正式部署后，在 App 里填写你的 HTTPS 后端地址。

## Supabase 配置

不需要在电脑上安装 PostgreSQL。建议使用 Supabase 托管 PostgreSQL 和 Storage。

1. 创建 Supabase 项目。
2. 在 Supabase SQL Editor 执行 `backend/supabase-schema.sql`。
3. 在 Supabase Storage 创建 bucket：

```text
practice-media
```

bucket 可以保持 private；后端会通过 `/api/media/file?id=...` 代理播放文件。

4. 启动后端前配置环境变量：

```powershell
$env:SUPABASE_URL="https://你的项目.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY="你的 service_role key"
$env:SUPABASE_STORAGE_BUCKET="practice-media"
$env:OPENAI_API_KEY="你的 OpenAI Key，可选，用于语音转文字"
node server.js
```

`DATABASE_URL` 可以保留给以后直连 PostgreSQL 使用；当前实现使用 Supabase REST 和 Storage API，因此只需要 `SUPABASE_URL` 和 `SUPABASE_SERVICE_ROLE_KEY`。

## 接口

- `GET /api/health`：检查后端是否可用，并返回当前存储模式。
- `POST /api/auth/phone`：手机号账号登录，占位登录，不发送真实短信验证码。
- `POST /api/auth/wechat`：微信登录占位接口，正式微信 OAuth 后续再接。
- `POST /api/sync/push`：把本机打卡、素材、收藏、复盘记录合并保存到云端。
- `POST /api/sync/pull`：读取云端同步数据。
- `POST /api/media/upload`：上传本次练习录音或镜头视频，返回 `mediaId` 和可播放的 `mediaUrl`。
- `GET /api/media/file?id=...`：播放云端媒体文件。
- `POST /api/media/delete`：删除云端媒体文件。
- `POST /api/transcribe`：语音转文字，需要配置 `OPENAI_API_KEY`。

## 当前登录策略

第一版为了尽快跑通云同步，只做“手机号账号”形式：

- 手机号格式合法即可登录。
- 不发送真实验证码。
- 同一手机号会得到同一个云端账号。

后续要正式发布时，再接短信服务或微信 OAuth。

