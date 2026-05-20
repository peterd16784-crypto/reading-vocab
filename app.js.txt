const STORAGE_KEY = "original-reading-vocab:v1";
const REVIEW_DAYS = [2, 4, 7, 15, 30];

const state = {
  entries: [],
  activeView: "capture",
  user: null,
  reviewAnswers: {},
  reviewChoices: {}
};

const $ = (selector) => document.querySelector(selector);

const entryForm = $("#entryForm");
const resultBox = $("#resultBox");
const wordList = $("#wordList");
const reviewList = $("#reviewList");
const searchInput = $("#search");
const manualFields = $("#manualFields");
const modeHint = $("#modeHint");
const editDialog = $("#editDialog");
const editForm = $("#editForm");
const mergeDialog = $("#mergeDialog");
const authScreen = $("#authScreen");
const appShell = $("#appShell");
const authForm = $("#authForm");
const authMessage = $("#authMessage");

let pendingMerge = null;

document.querySelectorAll(".tab").forEach((button) => {
  button.addEventListener("click", () => switchView(button.dataset.view));
});

document.querySelectorAll("input[name='entryMode']").forEach((radio) => {
  radio.addEventListener("change", updateEntryMode);
});

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const action = event.submitter?.dataset.authAction || "login";
  const form = new FormData(authForm);
  await authenticate(action, {
    email: String(form.get("email") || ""),
    password: String(form.get("password") || "")
  });
});

$("#logoutButton").addEventListener("click", logout);

entryForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("#analyzeButton");
  const form = new FormData(entryForm);
  const entryMode = String(form.get("entryMode") || "manual");
  const payload = {
    word: String(form.get("word")).trim(),
    context: String(form.get("context")).trim(),
    book: String(form.get("book")).trim(),
    page: String(form.get("page")).trim()
  };
  payload.source = `${payload.book}, ${payload.page}`;

  button.disabled = true;
  button.textContent = entryMode === "ai" ? "分析中..." : "保存中...";
  resultBox.hidden = true;

  try {
    const analysis = entryMode === "ai"
      ? await analyzeWithAi(payload)
      : buildManualAnalysis(form, payload);

    const mergeResult = upsertEntry(analysis, payload);
    if (mergeResult.type === "needsConfirmation") {
      showMergeDialog(mergeResult);
      return;
    }
    await saveEntries();
    entryForm.reset();
    render();
    showResult(mergeResult, analysis);
  } catch (error) {
    resultBox.hidden = false;
    resultBox.textContent = error.message || "分析失败，请稍后重试。";
  } finally {
    button.disabled = false;
    updateEntryMode();
  }
});

$("#clearData").addEventListener("click", async () => {
  if (!confirm("确定清空当前浏览器里的演示数据吗？")) return;
  state.entries = [];
  await saveEntries();
  render();
});

searchInput.addEventListener("input", renderNotebook);

$("#closeEdit").addEventListener("click", closeEditDialog);
$("#cancelEdit").addEventListener("click", closeEditDialog);
editDialog.addEventListener("click", (event) => {
  if (event.target === editDialog) closeEditDialog();
});

editForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const result = updateEntryFromEdit(new FormData(editForm));
    await saveEntries();
    closeEditDialog();
    render();
    showEditResult(result);
  } catch (error) {
    alert(error.message || "保存失败，请检查填写内容。");
  }
});

$("#closeMerge").addEventListener("click", () => closeMergeDialog(true));
$("#createSeparate").addEventListener("click", () => resolvePendingMerge(false));
mergeDialog.addEventListener("click", (event) => {
  if (event.target === mergeDialog) closeMergeDialog(true);
});

init();

async function init() {
  updateEntryMode();
  const session = await apiGet("/api/me");
  if (!session.user) {
    showAuth();
    return;
  }
  state.user = session.user;
  await loadEntries();
  await offerLocalMigration();
  showApp();
  render();
}

async function authenticate(action, payload) {
  authMessage.hidden = true;
  try {
    const result = await apiPost(`/api/auth/${action}`, payload);
    state.user = result.user;
    await loadEntries();
    await offerLocalMigration();
    authForm.reset();
    showApp();
    render();
  } catch (error) {
    authMessage.hidden = false;
    authMessage.textContent = error.message || "登录失败，请稍后重试。";
  }
}

async function logout() {
  await apiPost("/api/auth/logout", {});
  state.user = null;
  state.entries = [];
  showAuth();
}

function showAuth() {
  authScreen.hidden = false;
  appShell.hidden = true;
}

function showApp() {
  authScreen.hidden = true;
  appShell.hidden = false;
  $("#userEmail").textContent = state.user?.email || "";
}

async function apiGet(path) {
  const response = await fetch(path);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "请求失败。");
  return data;
}

async function apiPost(path, payload, method = "POST") {
  const response = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "请求失败。");
  return data;
}

async function analyzeWithAi(payload) {
  const response = await fetch("/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const analysis = await response.json();
  if (analysis.error) throw new Error(analysis.error);
  return analysis;
}

function buildManualAnalysis(form, payload) {
  const partOfSpeech = String(form.get("partOfSpeech") || "").trim();
  const englishMeaning = String(form.get("englishMeaning") || "").trim();
  const chineseMeaning = String(form.get("chineseMeaning") || "").trim();
  const examplesText = String(form.get("examples") || "").trim();

  if (!partOfSpeech || !englishMeaning || !chineseMeaning) {
    throw new Error("手动录入需要填写词性、英文释义和中文释义。");
  }

  const examples = parseExamples(examplesText);
  if (!examples.length) {
    throw new Error("请至少填写一个词典例句。");
  }

  return {
    lemma: payload.word,
    partOfSpeech,
    englishMeaning,
    chineseMeaning,
    senseKey: `${partOfSpeech}:${englishMeaning}:${chineseMeaning}`,
    examples,
    manual: true
  };
}

function parseExamples(examplesText) {
  return examplesText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3)
    .map((line) => {
      const separator = line.includes(" / ") ? " / " : line.includes("｜") ? "｜" : "";
      if (!separator) return { en: line, zh: "" };
      const [en, zh] = line.split(separator);
      return { en: en.trim(), zh: (zh || "").trim() };
    });
}

function formatExamples(examples) {
  return (examples || [])
    .map((example) => example.zh ? `${example.en} / ${example.zh}` : example.en)
    .join("\n");
}

function updateEntryMode() {
  const checked = document.querySelector("input[name='entryMode']:checked");
  const mode = checked?.value || "manual";
  manualFields.hidden = mode !== "manual";
  document.querySelectorAll(".modeOption").forEach((option) => {
    const input = option.querySelector("input");
    option.classList.toggle("active", input.value === mode);
  });
  $("#analyzeButton").textContent = mode === "ai" ? "分析并加入生词本" : "保存到生词本";
  modeHint.textContent = mode === "ai"
    ? "AI 模式需要后端配置 API Key；没有配置时会返回演示释义。"
    : "手动模式会直接保存你填写的释义和例句，适合暂时没有 API Key 时使用。";
}

function switchView(view) {
  state.activeView = view;
  document.querySelectorAll(".tab").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === view);
  });
  document.querySelectorAll(".view").forEach((section) => {
    section.classList.toggle("active", section.id === view);
  });
  if (view === "review") renderReview();
  if (view === "notebook") renderNotebook();
}

function upsertEntry(analysis, payload) {
  const now = new Date().toISOString();
  const senseKey = normalizeSense(analysis.senseKey || analysis.englishMeaning);
  const partOfSpeech = normalizeSense(analysis.partOfSpeech || "unknown");
  const lemma = normalizeSense(analysis.lemma || payload.word);
  const existing = state.entries.find((entry) => (
    entry.lemmaKey === lemma &&
    entry.partOfSpeechKey === partOfSpeech &&
    entry.senseKey === senseKey
  ));

  const occurrence = {
    context: payload.context,
    book: payload.book,
    page: payload.page,
    source: payload.source,
    createdAt: now
  };

  if (existing) {
    existing.occurrences.push(occurrence);
    existing.updatedAt = now;
    return { type: "merged", entry: existing, count: existing.occurrences.length };
  }

  const candidates = findSimilarEntries(lemma, partOfSpeech);
  if (candidates.length && !payload.forceCreate) {
    return {
      type: "needsConfirmation",
      candidates,
      analysis,
      payload,
      occurrence
    };
  }

  const entry = {
    id: crypto.randomUUID(),
    lemma: analysis.lemma || payload.word,
    lemmaKey: lemma,
    partOfSpeech: analysis.partOfSpeech || "unknown",
    partOfSpeechKey: partOfSpeech,
    englishMeaning: analysis.englishMeaning || "",
    chineseMeaning: analysis.chineseMeaning || "",
    senseKey,
    examples: analysis.examples || [],
    occurrences: [occurrence],
    createdAt: now,
    updatedAt: now,
    completedReviews: []
  };
  state.entries.unshift(entry);
  return { type: "created", entry, count: 1 };
}

function mergeIntoExistingEntry(entry, analysis, occurrence) {
  entry.occurrences.push(occurrence);
  entry.updatedAt = new Date().toISOString();
  return { type: "merged", entry, count: entry.occurrences.length, confirmed: true, analysis };
}

function updateEntryFromEdit(form) {
  const entryId = String(form.get("entryId") || "");
  const entry = state.entries.find((item) => item.id === entryId);
  if (!entry) throw new Error("没有找到这个词条。");

  const lemma = String(form.get("lemma") || "").trim();
  const partOfSpeech = String(form.get("partOfSpeech") || "").trim();
  const chineseMeaning = String(form.get("chineseMeaning") || "").trim();
  const englishMeaning = String(form.get("englishMeaning") || "").trim();
  const examples = parseExamples(String(form.get("examples") || ""));

  if (!lemma || !partOfSpeech || !chineseMeaning || !englishMeaning) {
    throw new Error("请填写单词、词性、中英文释义。");
  }
  if (!examples.length) {
    throw new Error("请至少填写一个例句。");
  }

  const lemmaKey = normalizeSense(lemma);
  const partOfSpeechKey = normalizeSense(partOfSpeech);
  const senseKey = normalizeSense(`${partOfSpeech}:${englishMeaning}:${chineseMeaning}`);
  const duplicate = state.entries.find((item) => (
    item.id !== entryId &&
    item.lemmaKey === lemmaKey &&
    item.partOfSpeechKey === partOfSpeechKey &&
    item.senseKey === senseKey
  ));

  entry.lemma = lemma;
  entry.lemmaKey = lemmaKey;
  entry.partOfSpeech = partOfSpeech;
  entry.partOfSpeechKey = partOfSpeechKey;
  entry.chineseMeaning = chineseMeaning;
  entry.englishMeaning = englishMeaning;
  entry.senseKey = senseKey;
  entry.examples = examples;
  entry.updatedAt = new Date().toISOString();
  entry.manual = true;

  if (!duplicate) {
    return { type: "updated", entry, count: entry.occurrences.length };
  }

  duplicate.occurrences.push(...entry.occurrences);
  duplicate.completedReviews = mergeReviewRecords(duplicate.completedReviews, entry.completedReviews);
  duplicate.examples = examples;
  duplicate.englishMeaning = englishMeaning;
  duplicate.chineseMeaning = chineseMeaning;
  duplicate.updatedAt = new Date().toISOString();
  state.entries = state.entries.filter((item) => item.id !== entryId);
  return { type: "merged", entry: duplicate, count: duplicate.occurrences.length };
}

function mergeReviewRecords(a = [], b = []) {
  const records = new Map();
  [...a, ...b].forEach((record) => {
    const key = `${record.day}:${record.completedAt || ""}`;
    records.set(key, record);
  });
  return [...records.values()];
}

function showResult(result, analysis) {
  resultBox.hidden = false;
  const prefix = result.type === "merged"
    ? `已合并到已有词条。这是第 ${result.count} 次录入这个词义。`
    : "已创建新词条。";
  resultBox.innerHTML = `
    <strong>${escapeHtml(prefix)}</strong>
    <p>${escapeHtml(analysis.lemma)} · ${escapeHtml(analysis.partOfSpeech)} · ${escapeHtml(analysis.chineseMeaning)}</p>
    ${analysis.manual ? "<p>已按手动填写内容保存。</p>" : ""}
    ${analysis.demo ? "<p>当前是演示模式：配置 OPENAI_API_KEY 后会调用真实 AI。</p>" : ""}
  `;
}

function showMergeDialog(result) {
  pendingMerge = result;
  const incoming = result.analysis;
  $("#mergeCompare").innerHTML = `
    <section class="mergeSide incomingSide">
      <strong>这次录入</strong>
      <h3>${escapeHtml(incoming.lemma)}</h3>
      <p>${escapeHtml(incoming.partOfSpeech)} · ${escapeHtml(incoming.chineseMeaning)}</p>
      <p>${escapeHtml(incoming.englishMeaning)}</p>
      <ul>${incoming.examples.map((example) => `<li>${escapeHtml(example.en)}${example.zh ? ` / ${escapeHtml(example.zh)}` : ""}</li>`).join("")}</ul>
      <span class="sourcePill">新出处 1 次</span>
    </section>
    <section class="mergeCandidates">
      <strong>可合并的已有词条</strong>
      <div class="candidateList">
        ${result.candidates.map((candidate) => renderMergeCandidate(candidate)).join("")}
      </div>
    </section>
  `;
  $("#mergeCompare").querySelectorAll("[data-merge-id]").forEach((button) => {
    button.addEventListener("click", () => resolvePendingMerge(button.dataset.mergeId));
  });
  mergeDialog.showModal();
}

function renderMergeCandidate(candidate) {
  const latestSource = candidate.occurrences.at(-1)?.source || "暂无出处";
  const examples = candidate.examples.slice(0, 2)
    .map((example) => `<li>${escapeHtml(example.en)}${example.zh ? ` / ${escapeHtml(example.zh)}` : ""}</li>`)
    .join("");
  return `
    <article class="candidateCard">
      <div class="candidateTop">
        <div>
          <h3>${escapeHtml(candidate.lemma)}</h3>
          <p>${escapeHtml(candidate.partOfSpeech)} · ${escapeHtml(candidate.chineseMeaning)}</p>
        </div>
        <span class="sourcePill">重复遇见 ${candidate.occurrences.length} 次</span>
      </div>
      <p>${escapeHtml(candidate.englishMeaning)}</p>
      <ul>${examples}</ul>
      <div class="candidateFooter">
        <span class="sourcePill">${escapeHtml(latestSource)}</span>
        <button class="primaryButton compactButton" type="button" data-merge-id="${escapeHtml(candidate.id)}">合并到这个词条</button>
      </div>
    </article>
  `;
}

async function resolvePendingMerge(candidateId) {
  if (!pendingMerge) return;
  const result = pendingMerge;
  pendingMerge = null;
  mergeDialog.close();

  const candidate = candidateId
    ? state.entries.find((entry) => entry.id === candidateId)
    : null;
  const finalResult = candidate
    ? mergeIntoExistingEntry(candidate, result.analysis, result.occurrence)
    : upsertEntry(result.analysis, { ...result.payload, forceCreate: true });

  await saveEntries();
  entryForm.reset();
  render();
  showResult(finalResult, result.analysis);
}

function closeMergeDialog(keepForm) {
  pendingMerge = null;
  mergeDialog.close();
  if (!keepForm) entryForm.reset();
}

function showEditResult(result) {
  const message = result.type === "merged"
    ? `修改已保存，并与已有词条合并。现在共有 ${result.count} 次出处。`
    : "词条修改已保存。";
  switchView("notebook");
  const notice = $("#notebookNotice");
  notice.hidden = false;
  notice.innerHTML = `<strong>${escapeHtml(message)}</strong>`;
}

function render() {
  $("#wordCount").textContent = String(state.entries.length);
  $("#totalEntries").textContent = String(state.entries.length);
  $("#reviewCount").textContent = String(getDueEntries().length);
  renderNotebook();
  renderReview();
}

function renderNotebook() {
  const keyword = normalizeSense(searchInput.value || "");
  const entries = state.entries.filter((entry) => {
    if (!keyword) return true;
    const haystack = normalizeSense([
      entry.lemma,
      entry.partOfSpeech,
      entry.englishMeaning,
      entry.chineseMeaning,
      ...entry.occurrences.map((item) => `${item.source} ${item.context}`)
    ].join(" "));
    return haystack.includes(keyword);
  });
  wordList.innerHTML = "";
  if (!entries.length) {
    wordList.innerHTML = `<div class="empty">还没有匹配的生词。</div>`;
    return;
  }
  entries.forEach((entry) => wordList.appendChild(renderWordCard(entry)));
}

function renderReview() {
  const dueEntries = getDueEntries();
  reviewList.innerHTML = "";
  if (!dueEntries.length) {
    reviewList.innerHTML = `<div class="empty">今天没有到期复习的词条。录入新词后，第 2、4、7、15、30 天会出现在这里。</div>`;
    return;
  }
  dueEntries.forEach(({ entry, dueDay }) => {
    reviewList.appendChild(renderReviewQuizCard(entry, dueDay));
  });
}

function renderReviewQuizCard(entry, dueDay) {
  const card = document.createElement("article");
  card.className = "reviewQuizCard";
  const key = reviewKey(entry.id, dueDay);
  const answer = state.reviewAnswers[key];
  const choices = getReviewChoices(entry, key);
  const latestOccurrence = entry.occurrences.at(-1);

  card.innerHTML = `
    <div class="quizTop">
      <div>
        <span class="sourcePill">第 ${dueDay} 天复习</span>
        <h3>${escapeHtml(entry.lemma)}</h3>
        <p>${escapeHtml(entry.partOfSpeech)} · ${escapeHtml(latestOccurrence?.source || "暂无出处")}</p>
      </div>
      <span class="badge">四选一</span>
    </div>
    <div class="quizContext">
      <span>原文语境</span>
      <blockquote>${escapeHtml(latestOccurrence?.context || "暂无原文语境")}</blockquote>
    </div>
    <div class="choiceGrid">
      ${choices.map((choice) => `
        <button class="choiceButton" type="button" data-choice="${escapeHtml(choice)}">
          ${escapeHtml(choice)}
        </button>
      `).join("")}
    </div>
    <div class="reviewReveal" ${answer ? "" : "hidden"}></div>
  `;

  card.querySelectorAll(".choiceButton").forEach((button) => {
    const selected = button.dataset.choice;
    const isCorrectChoice = selected === entry.chineseMeaning;
    if (answer) {
      button.disabled = true;
      button.classList.toggle("correctChoice", isCorrectChoice);
      button.classList.toggle("wrongChoice", selected === answer.selected && !answer.correct);
    } else {
      button.addEventListener("click", () => {
        state.reviewAnswers[key] = {
          selected,
          correct: isCorrectChoice
        };
        renderReview();
      });
    }
  });

  if (answer) {
    const reveal = card.querySelector(".reviewReveal");
    reveal.innerHTML = renderReviewReveal(entry, dueDay, answer);
    reveal.querySelectorAll("[data-rating]").forEach((button) => {
      button.addEventListener("click", () => {
        completeReview(entry.id, dueDay, button.dataset.rating, answer);
      });
    });
  }

  return card;
}

function renderReviewReveal(entry, dueDay, answer) {
  const resultLabel = answer.correct ? "回答正确" : "回答错误";
  const resultClass = answer.correct ? "correctText" : "wrongText";
  const sources = entry.occurrences.map((occurrence) => `
    <article class="sourceItem">
      <div class="sourceTitle">${escapeHtml(occurrence.source)}</div>
      <blockquote>${escapeHtml(occurrence.context || "暂无原文语境")}</blockquote>
    </article>
  `).join("");
  const examples = entry.examples.map((example) => `
    <li>${escapeHtml(example.en)}${example.zh ? ` / ${escapeHtml(example.zh)}` : ""}</li>
  `).join("");

  return `
    <div class="answerSummary">
      <strong class="${resultClass}">${resultLabel}</strong>
      <p>你的选择：${escapeHtml(answer.selected)}</p>
      <p>正确释义：${escapeHtml(entry.chineseMeaning)}</p>
    </div>
    <div class="recordedMeaning">
      <h4>${escapeHtml(entry.lemma)} · ${escapeHtml(entry.partOfSpeech)}</h4>
      <p>${escapeHtml(entry.englishMeaning)}</p>
      <ul>${examples}</ul>
      <div class="sources">${sources}</div>
    </div>
    <div class="reviewActions">
      ${["认识", "模糊", "不认识"].map((label) => `
        <button type="button" data-rating="${label}">${label}</button>
      `).join("")}
    </div>
  `;
}

function getReviewChoices(entry, key) {
  if (state.reviewChoices[key]) return state.reviewChoices[key];
  const distractors = uniqueValues(
    state.entries
      .filter((item) => item.id !== entry.id)
      .map((item) => item.chineseMeaning)
      .filter(Boolean)
  );
  const fallback = ["严肃的，严重的", "努力，尽力", "面容，表情", "奇特的，特别的", "逃避，避开", "宁静的，平静的"];
  const pool = uniqueValues([...distractors, ...fallback])
    .filter((meaning) => meaning !== entry.chineseMeaning)
    .slice(0, 3);
  const choices = shuffleChoices([entry.chineseMeaning, ...pool]).slice(0, 4);
  state.reviewChoices[key] = choices;
  return choices;
}

function reviewKey(entryId, dueDay) {
  return `${entryId}:${dueDay}`;
}

function uniqueValues(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function shuffleChoices(values) {
  return values
    .map((value) => ({ value, sort: Math.random() }))
    .sort((a, b) => a.sort - b.sort)
    .map((item) => item.value);
}

function renderWordCard(entry) {
  const template = $("#wordTemplate").content.cloneNode(true);
  const card = template.querySelector(".wordCard");
  template.querySelector("h3").textContent = entry.lemma;
  template.querySelector(".meaning").textContent = `${entry.partOfSpeech} · ${entry.chineseMeaning}`;
  template.querySelector(".englishMeaning").textContent = entry.englishMeaning;
  template.querySelector(".badge").textContent = `重复遇见 ${entry.occurrences.length} 次`;

  const examples = template.querySelector(".examples");
  examples.innerHTML = "";
  entry.examples.forEach((example) => {
    const item = document.createElement("li");
    item.textContent = `${example.en} / ${example.zh}`;
    examples.appendChild(item);
  });

  const sources = template.querySelector(".sources");
  entry.occurrences.forEach((occurrence) => {
    const sourceItem = document.createElement("article");
    sourceItem.className = "sourceItem";
    const sourceTitle = document.createElement("div");
    sourceTitle.className = "sourceTitle";
    sourceTitle.textContent = occurrence.source;
    const context = document.createElement("blockquote");
    context.textContent = occurrence.context || "暂无原文语境";
    sourceItem.append(sourceTitle, context);
    sources.appendChild(sourceItem);
  });

  const actions = document.createElement("div");
  actions.className = "cardActions";
  const editButton = document.createElement("button");
  editButton.type = "button";
  editButton.className = "smallButton";
  editButton.textContent = "编辑";
  editButton.addEventListener("click", () => openEditDialog(entry.id));
  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.className = "smallButton dangerButton";
  deleteButton.textContent = "删除";
  deleteButton.addEventListener("click", () => deleteEntry(entry.id));
  actions.appendChild(editButton);
  actions.appendChild(deleteButton);
  card.appendChild(actions);

  return template;
}

async function deleteEntry(entryId) {
  const entry = state.entries.find((item) => item.id === entryId);
  if (!entry) return;
  const confirmed = confirm(`确定删除「${entry.lemma}」这个词条吗？它的出处和复习记录也会一起删除。`);
  if (!confirmed) return;
  state.entries = state.entries.filter((item) => item.id !== entryId);
  await saveEntries();
  render();
  const notice = $("#notebookNotice");
  notice.hidden = false;
  notice.innerHTML = `<strong>${escapeHtml(`已删除「${entry.lemma}」。`)}</strong>`;
}

function openEditDialog(entryId) {
  const entry = state.entries.find((item) => item.id === entryId);
  if (!entry) return;
  $("#editEntryId").value = entry.id;
  $("#editLemma").value = entry.lemma;
  $("#editPartOfSpeech").value = entry.partOfSpeech;
  $("#editChineseMeaning").value = entry.chineseMeaning;
  $("#editEnglishMeaning").value = entry.englishMeaning;
  $("#editExamples").value = formatExamples(entry.examples);
  editDialog.showModal();
}

function closeEditDialog() {
  editDialog.close();
  editForm.reset();
}

function getDueEntries() {
  const today = startOfDay(new Date());
  return state.entries.flatMap((entry) => {
    const created = startOfDay(new Date(entry.createdAt));
    const age = Math.floor((today - created) / 86400000);
    if (!REVIEW_DAYS.includes(age)) return [];
    const done = entry.completedReviews.some((item) => item.day === age);
    return done ? [] : [{ entry, dueDay: age }];
  });
}

async function completeReview(entryId, dueDay, rating, quizAnswer = null) {
  const entry = state.entries.find((item) => item.id === entryId);
  if (!entry) return;
  entry.completedReviews.push({
    day: dueDay,
    rating,
    quiz: quizAnswer ? {
      selected: quizAnswer.selected,
      correct: quizAnswer.correct
    } : null,
    completedAt: new Date().toISOString()
  });
  delete state.reviewAnswers[reviewKey(entryId, dueDay)];
  delete state.reviewChoices[reviewKey(entryId, dueDay)];
  await saveEntries();
  render();
}

async function loadEntries() {
  const data = await apiGet("/api/entries");
  state.entries = data.entries || [];
}

async function saveEntries() {
  await apiPost("/api/entries", { entries: state.entries }, "PUT");
}

function loadLocalEntries() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  } catch {
    return [];
  }
}

async function offerLocalMigration() {
  const localEntries = loadLocalEntries();
  if (!localEntries.length || state.entries.length) return;
  const confirmed = confirm("检测到这个浏览器里有旧版本地生词数据，要导入到当前账号吗？");
  if (!confirmed) return;
  state.entries = localEntries;
  await saveEntries();
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function normalizeSense(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function findSimilarEntries(lemmaKey, partOfSpeechKey) {
  const root = simpleWordRoot(lemmaKey);
  return state.entries
    .map((entry) => ({ entry, score: scoreSimilarEntry(entry, lemmaKey, partOfSpeechKey, root) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((item) => item.entry);
}

function scoreSimilarEntry(entry, lemmaKey, partOfSpeechKey, root) {
    if (entry.lemmaKey === lemmaKey) return 0;
    const samePartOfSpeech = !partOfSpeechKey ||
      !entry.partOfSpeechKey ||
      entry.partOfSpeechKey === "unknown" ||
      partOfSpeechKey === "unknown" ||
      entry.partOfSpeechKey === partOfSpeechKey;
    if (!samePartOfSpeech) return 0;
    const entryRoot = simpleWordRoot(entry.lemmaKey);
    if (entryRoot === root) return 100;
    if (entry.lemmaKey.startsWith(root) || lemmaKey.startsWith(entryRoot)) return 80;
    const distance = levenshteinDistance(entry.lemmaKey, lemmaKey);
    if (distance <= 1) return 70;
    if (distance <= 2) return 55;
    return 0;
}

function simpleWordRoot(word) {
  let value = normalizeSense(word).replace(/[^a-z]/g, "");
  if (value.length > 4 && value.endsWith("ies")) return `${value.slice(0, -3)}y`;
  if (value.length > 4 && value.endsWith("ied")) return `${value.slice(0, -3)}y`;
  if (value.length > 3 && value.endsWith("ed")) value = value.slice(0, -2);
  if (value.length > 4 && value.endsWith("ing")) value = value.slice(0, -3);
  if (value.length > 3 && value.endsWith("s")) value = value.slice(0, -1);
  if (value.length > 2 && value.endsWith(value.at(-1) + value.at(-1))) value = value.slice(0, -1);
  return value;
}

function levenshteinDistance(a, b) {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[b.length];
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  })[char]);
}
