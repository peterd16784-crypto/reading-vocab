# 原版阅读词汇小程序 Web MVP

这是一个网页端原型，包含：

- 生词录入：单词原型、原文语境、书名、页码/位置
- AI 语境分析：词性、中英文释义、词典风格例句
- 手动录入：暂时没有 API Key 时，可以自己填写词性、释义和例句
- 生词本：同一单词 + 同一词性 + 同一语义自动合并出处
- 今日复习：第 2、4、7、15、30 天进入复习
- 本地账户：支持邮箱密码注册、登录、退出
- 本地数据库：当前版本把账号和生词保存在 `data/db.json`

## 运行

```bash
node server.js
```

打开：

```text
http://localhost:3000
```

## 接入 OpenAI

复制 `.env.example` 为 `.env`，至少设置：

```text
OPENAI_API_KEY=你的 API Key
OPENAI_MODEL=gpt-4.1-mini
PORT=3000
```

如果没有设置 `OPENAI_API_KEY`，应用会进入演示模式，返回模拟释义，方便先体验完整流程。

## 账户系统

打开网页后先注册或登录。每个邮箱账号有独立生词本，词条、出处和复习记录会保存到 `data/db.json`。

如果浏览器里存在旧版 `localStorage` 生词数据，登录后会询问是否导入到当前账号。

## 下一步建议

- 部署到 Render / Railway 时，给 `/app/data` 配置持久磁盘
- 把 `data/db.json` 换成 PostgreSQL / Supabase
- 把“是否合并”从简单 key 匹配升级为 AI 判断候选词义
- 增加导出 Anki / CSV
- 增加复习测验模式

## 部署

见 [DEPLOY.md](./DEPLOY.md)。如果使用 Render，直接看 [RENDER.md](./RENDER.md)。
