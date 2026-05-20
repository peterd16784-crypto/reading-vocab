# 部署说明

当前项目是一个无依赖 Node.js 应用，可以部署到支持 Node 服务或 Docker 的平台。

## 推荐路径：Render / Railway / Fly.io

这些平台适合当前版本，因为应用需要一个长期运行的 Node 服务。

生产环境变量：

```text
NODE_ENV=production
PORT=3000
OPENAI_API_KEY=可选
OPENAI_MODEL=gpt-4.1-mini
```

如果平台自动注入 `PORT`，使用平台默认值即可。

## 数据持久化

账号和生词数据会写入：

```text
/app/data/db.json
```

正式部署时需要配置持久磁盘或 volume，并挂载到：

```text
/app/data
```

如果不配置持久磁盘，某些平台在重启、重新部署后可能丢失账号和生词数据。

## Docker

本地构建：

```bash
docker build -t original-reading-vocab .
```

本地运行：

```bash
docker run --rm -p 3000:3000 -v "$PWD/data:/app/data" original-reading-vocab
```

打开：

```text
http://localhost:3000
```

## 后续正式化建议

当前部署方案适合 MVP。长期产品建议把 `data/db.json` 迁移到 PostgreSQL / Supabase，并把 session 存到数据库或 Redis。
