import http from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import crypto from "node:crypto";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");
const dataDir = join(__dirname, "data");
const dbPath = join(dataDir, "db.json");
loadDotEnv(join(__dirname, ".env"));
const port = Number(process.env.PORT || 3000);
const sessions = new Map();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/api/health") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/me") {
      const user = await getUserFromRequest(req);
      sendJson(res, 200, { user: user ? publicUser(user) : null });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/auth/register") {
      const payload = await readJson(req);
      const result = await registerUser(payload);
      if (result.error) {
        sendJson(res, 400, result);
        return;
      }
      setSessionCookie(res, result.user.id);
      sendJson(res, 200, { user: publicUser(result.user) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/auth/login") {
      const payload = await readJson(req);
      const result = await loginUser(payload);
      if (result.error) {
        sendJson(res, 401, result);
        return;
      }
      setSessionCookie(res, result.user.id);
      sendJson(res, 200, { user: publicUser(result.user) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/auth/logout") {
      const sessionId = getCookie(req, "session");
      if (sessionId) sessions.delete(sessionId);
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Set-Cookie": "session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"
      });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/entries") {
      const user = await requireUser(req, res);
      if (!user) return;
      sendJson(res, 200, { entries: user.entries || [] });
      return;
    }

    if (req.method === "PUT" && url.pathname === "/api/entries") {
      const user = await requireUser(req, res);
      if (!user) return;
      const payload = await readJson(req);
      const entries = Array.isArray(payload.entries) ? payload.entries : [];
      const db = await readDb();
      const target = db.users.find((item) => item.id === user.id);
      target.entries = entries;
      target.updatedAt = new Date().toISOString();
      await writeDb(db);
      sendJson(res, 200, { entries });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/analyze") {
      const payload = await readJson(req);
      const result = await analyzeWord(payload);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "GET") {
      const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
      const safePath = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
      const filePath = join(publicDir, safePath);
      if (!filePath.startsWith(publicDir)) {
        sendText(res, 403, "Forbidden");
        return;
      }
      const file = await readFile(filePath);
      res.writeHead(200, { "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream" });
      res.end(file);
      return;
    }

    sendText(res, 404, "Not found");
  } catch (error) {
    if (error?.code === "ENOENT") {
      sendText(res, 404, "Not found");
      return;
    }
    console.error(error);
    sendJson(res, 500, { error: "服务器出错了，请稍后重试。" });
  }
});

const host = process.env.HOST || (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");

server.listen(port, host, () => {
  console.log(`Original Reading Vocab is running at http://${host}:${port}`);
});

async function readJson(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function sendText(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

async function registerUser(payload) {
  const email = normalizeEmail(payload.email);
  const password = String(payload.password || "");
  if (!email || !email.includes("@")) return { error: "请输入有效邮箱。" };
  if (password.length < 6) return { error: "密码至少需要 6 位。" };

  const db = await readDb();
  if (db.users.some((user) => user.email === email)) {
    return { error: "这个邮箱已经注册过。" };
  }
  const now = new Date().toISOString();
  const user = {
    id: crypto.randomUUID(),
    email,
    passwordHash: hashPassword(password),
    entries: [],
    createdAt: now,
    updatedAt: now
  };
  db.users.push(user);
  await writeDb(db);
  return { user };
}

async function loginUser(payload) {
  const email = normalizeEmail(payload.email);
  const password = String(payload.password || "");
  const db = await readDb();
  const user = db.users.find((item) => item.email === email);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return { error: "邮箱或密码不正确。" };
  }
  return { user };
}

async function requireUser(req, res) {
  const user = await getUserFromRequest(req);
  if (!user) {
    sendJson(res, 401, { error: "请先登录。" });
    return null;
  }
  return user;
}

async function getUserFromRequest(req) {
  const sessionId = getCookie(req, "session");
  const session = sessionId ? sessions.get(sessionId) : null;
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    sessions.delete(sessionId);
    return null;
  }
  const db = await readDb();
  return db.users.find((user) => user.id === session.userId) || null;
}

function setSessionCookie(res, userId) {
  const sessionId = crypto.randomBytes(32).toString("hex");
  sessions.set(sessionId, {
    userId,
    expiresAt: Date.now() + 1000 * 60 * 60 * 24 * 30
  });
  res.setHeader("Set-Cookie", `session=${sessionId}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 30}`);
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email
  };
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || "").split(":");
  if (!salt || !hash) return false;
  const nextHash = crypto.pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("hex");
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(nextHash, "hex"));
}

function getCookie(req, name) {
  const cookie = req.headers.cookie || "";
  return cookie
    .split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

async function readDb() {
  await ensureDb();
  return JSON.parse(await readFile(dbPath, "utf8"));
}

async function writeDb(db) {
  await mkdir(dataDir, { recursive: true });
  await writeFile(dbPath, JSON.stringify(db, null, 2));
}

async function ensureDb() {
  if (existsSync(dbPath)) return;
  await mkdir(dataDir, { recursive: true });
  await writeDb({ users: [] });
}

async function analyzeWord(payload) {
  const word = String(payload.word || "").trim();
  const context = String(payload.context || "").trim();
  const source = String(payload.source || "").trim();

  if (!word || !context || !source) {
    return { error: "请填写单词、语境句子和出处。" };
  }

  if (!process.env.OPENAI_API_KEY) {
    return mockAnalysis(word, context);
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: [
                "你是英文原版阅读词汇助手。",
                "任务：根据用户提供的英文单词、原文语境和出处，判断这个单词在此语境里的词性、英文释义、中文释义，并给出2-3个词典风格例句。",
                "只返回严格 JSON，不要 Markdown。",
                "JSON 字段：lemma, partOfSpeech, englishMeaning, chineseMeaning, senseKey, examples。",
                "examples 是数组，每项包含 en 和 zh。",
                "senseKey 用小写英文短语概括语义，用于判断相同词性同义项合并。"
              ].join("\n")
            }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: JSON.stringify({ word, context, source }, null, 2)
            }
          ]
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "vocabulary_analysis",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              lemma: { type: "string" },
              partOfSpeech: { type: "string" },
              englishMeaning: { type: "string" },
              chineseMeaning: { type: "string" },
              senseKey: { type: "string" },
              examples: {
                type: "array",
                minItems: 2,
                maxItems: 3,
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    en: { type: "string" },
                    zh: { type: "string" }
                  },
                  required: ["en", "zh"]
                }
              }
            },
            required: ["lemma", "partOfSpeech", "englishMeaning", "chineseMeaning", "senseKey", "examples"]
          }
        }
      }
    })
  });

  const data = await response.json();
  if (!response.ok) {
    return {
      error: data?.error?.message || "AI 分析失败，请检查 API Key 或模型配置。"
    };
  }

  const text = data.output_text || data.output?.flatMap((item) => item.content || [])
    .find((content) => content.type === "output_text")?.text;

  try {
    return JSON.parse(text);
  } catch {
    return { error: "AI 返回格式无法解析，请重试。", raw: text };
  }
}

function mockAnalysis(word, context) {
  const lemma = word.toLowerCase();
  return {
    lemma,
    partOfSpeech: "unknown",
    englishMeaning: `Meaning of "${lemma}" inferred from the supplied sentence.`,
    chineseMeaning: "演示模式：请配置 OPENAI_API_KEY 后获取真实语境释义。",
    senseKey: `${lemma}:demo-sense`,
    examples: [
      {
        en: context,
        zh: "这是你提供的原文语境。"
      },
      {
        en: `The word "${lemma}" should be interpreted according to context.`,
        zh: "这个词应根据上下文理解。"
      }
    ],
    demo: true
  };
}

function loadDotEnv(filePath) {
  try {
    const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index === -1) continue;
      const key = trimmed.slice(0, index).trim();
      const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // .env is optional; without it the app runs in demo mode.
  }
}
