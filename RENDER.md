# Render 部署步骤

## 1. 上传到 GitHub

在项目目录里执行：

```bash
git init
git add .
git commit -m "Initial original reading vocab app"
```

然后在 GitHub 创建一个新仓库，把本地项目 push 上去。

不要上传：

- `.env`
- `data/db.json`

这两个已经在 `.gitignore` 里排除了。

## 2. 创建 Render Web Service

1. 打开 Render
2. New -> Web Service
3. 连接 GitHub 仓库
4. 选择这个项目

配置：

```text
Runtime: Node
Build Command: 留空
Start Command: npm start
```

环境变量：

```text
NODE_ENV=production
OPENAI_MODEL=gpt-4.1-mini
OPENAI_API_KEY=可选
```

Render 会自动提供 `PORT`，不需要手动设置。

## 3. 配置持久磁盘

账号和生词数据写入：

```text
/app/data/db.json
```

需要在 Render 给服务添加 Disk：

```text
Mount Path: /app/data
Size: 1 GB
```

如果不配置磁盘，重新部署或服务重启后，账号和生词数据可能丢失。

## 4. 部署后检查

部署成功后打开：

```text
https://你的应用名.onrender.com/api/health
```

看到：

```json
{"ok":true}
```

说明服务正常。

然后打开：

```text
https://你的应用名.onrender.com
```

注册账号即可使用。
