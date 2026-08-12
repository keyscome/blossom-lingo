const DEFAULTS = {
  endpoint: "http://127.0.0.1:11434",
  model: "qwen3:8b",
  targetLanguage: "Simplified Chinese",
  temperature: 0.1,
};
const BATCH_KEY = "llt:batch";
const BATCH_HISTORY_KEY = "llt:batch-history";
const HISTORY_MAX_TASKS = 20;
const HISTORY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
let batchTimer = 0;
let articleTimer = 0;
let discoveryTimer = 0;
const activeRequests = new Map();
let lastInference = null;

async function settings() {
  return { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
}

function stripFence(value) {
  return value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
}

const TRANSLATION_SCHEMA = {
  type: "object",
  properties: {
    translations: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, text: { type: "string" } },
        required: ["id", "text"],
        additionalProperties: false,
      },
    },
  },
  required: ["translations"],
  additionalProperties: false,
};

function parseTranslations(content, items) {
  const parsed = JSON.parse(stripFence(content || ""));
  if (!Array.isArray(parsed.translations)) throw new Error("模型没有返回 translations 数组");
  const expected = new Set(items.map((item) => item.id));
  const actual = new Set();
  for (const item of parsed.translations) {
    if (!expected.has(item?.id) || typeof item?.text !== "string" || !item.text.trim() || actual.has(item.id)) {
      throw new Error("模型返回的翻译条目不完整或 ID 不匹配");
    }
    actual.add(item.id);
  }
  if (actual.size !== expected.size) throw new Error(`模型只返回了 ${actual.size}/${expected.size} 条译文`);
  return parsed.translations;
}

async function translatePlainItem(item, config, job) {
  const response = await fetch(`${config.endpoint.replace(/\/$/, "")}/api/chat`, {
    signal: job.controller.signal,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.model,
      stream: false,
      think: false,
      options: { temperature: 0, num_predict: 8192 },
      messages: [{
        role: "user",
        content: `Translate the following English technical text to ${config.targetLanguage}. Preserve every placeholder matching ⟦LLT<number>⟧ exactly once and unchanged. Return only the translation, without quotes, JSON, notes, or commentary.\n\n${item.text}`,
      }],
    }),
  });
  if (!response.ok) throw new Error(`Ollama ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const data = await response.json();
  const text = data.message?.content?.trim();
  if (!text) throw new Error("模型返回了空译文");
  return { id: item.id, text };
}

async function translateCore(items, job) {
  const config = await settings();
  if (config.model.toLowerCase().startsWith("translategemma")) {
    const translations = [];
    for (const item of items) {
      const response = await fetch(`${config.endpoint.replace(/\/$/, "")}/api/chat`, {
        signal: job.controller.signal,
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: config.model, stream: false, options: { temperature: 0 }, messages: [{ role: "user", content: "You are a professional English (en) to Simplified Chinese (zh-Hans) translator. Your goal is to accurately convey the meaning and nuances of the original English text while adhering to Simplified Chinese grammar and standard data-structures-and-algorithms terminology. Preserve every placeholder matching ⟦LLT<number>⟧ exactly once and unchanged. Produce only the Simplified Chinese translation, without any additional explanations or commentary. Please translate the following English text into Simplified Chinese:\n\n" + item.text }] })
      });
      if (!response.ok) throw new Error(`Ollama ${response.status}: ${(await response.text()).slice(0, 300)}`);
      const data = await response.json();
      translations.push({ id: item.id, text: data.message?.content?.trim() || "" });
    }
    return translations;
  }
  const response = await fetch(`${config.endpoint.replace(/\/$/, "")}/api/chat`, {
    signal: job.controller.signal,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.model,
      stream: false,
      think: false,
      format: TRANSLATION_SCHEMA,
      options: { temperature: 0, num_predict: 8192 },
      messages: [
        {
          role: "system",
          content:
            `You are a precise technical translator. Translate each item to ${config.targetLanguage}. ` +
            "Preserve meaning, identifiers, and every placeholder token matching ⟦LLT<number>⟧ exactly once and unchanged. " +
            "Use standard data-structures-and-algorithms terminology. Do not explain, summarize, censor, or add content. " +
            "Return only valid JSON in the exact form {\"translations\":[{\"id\":\"...\",\"text\":\"...\"}]}."
        },
        { role: "user", content: JSON.stringify({ items }) }
      ]
    })
  });

  if (!response.ok) {
    const body = await response.text();
    if (response.status === 403) {
      throw new Error("Ollama 拒绝了扩展来源（403）。请打开“模型与服务设置”，按页面中的 macOS 步骤授权本扩展后重启 Ollama。");
    }
    throw new Error(`Ollama ${response.status}: ${body.slice(0, 300)}`);
  }
  const data = await response.json();
  try {
    return parseTranslations(data.message?.content, items);
  } catch (_error) {
    const translations = [];
    for (const item of items) translations.push(await translatePlainItem(item, config, job));
    return translations;
  }
}

async function translate(items) {
  const config = await settings(); const id = crypto.randomUUID();
  const job = { id, controller: new AbortController(), model: config.model, itemCount: items.length, startedAt: Date.now() };
  activeRequests.set(id, job);
  try { const result = await translateCore(items, job); lastInference = { model: job.model, itemCount: job.itemCount, startedAt: job.startedAt, finishedAt: Date.now(), status: "completed" }; return result; }
  catch (error) { const cancelled = error.name === "AbortError"; lastInference = { model: job.model, itemCount: job.itemCount, startedAt: job.startedAt, finishedAt: Date.now(), status: cancelled ? "cancelled" : "failed", error: error.message }; throw new Error(cancelled ? "翻译请求已取消" : error.message); }
  finally { activeRequests.delete(id); }
}

function abortActiveRequests() { const count = activeRequests.size; for (const job of activeRequests.values()) job.controller.abort(); return count; }

async function ollamaStatus() { const config = await settings(); const response = await fetch(`${config.endpoint.replace(/\/$/, "")}/api/ps`); if (!response.ok) throw new Error(`Ollama ${response.status}`); const data = await response.json(); return { activeRequests: [...activeRequests.values()].map(({ id, model, itemCount, startedAt }) => ({ id, model, itemCount, startedAt })), loadedModels: data.models || [], lastInference }; }

async function unloadModel(model) { abortActiveRequests(); const config = await settings(); const response = await fetch(`${config.endpoint.replace(/\/$/, "")}/api/generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model, keep_alive: 0, stream: false }) }); if (!response.ok) throw new Error(`卸载失败：Ollama ${response.status}`); return { model }; }

async function health() {
  const config = await settings();
  const base = config.endpoint.replace(/\/$/, "");
  const tagsResponse = await fetch(`${base}/api/tags`);
  if (!tagsResponse.ok) {
    if (tagsResponse.status === 403) throw new Error("Ollama 403：尚未授权此扩展来源，请进入设置按提示配置");
    throw new Error(`Ollama ${tagsResponse.status}`);
  }
  // POST /api/chat uses a CORS preflight while GET /api/tags may not. Test the
  // actual preflight so the health check cannot report a false positive.
  const corsResponse = await fetch(`${base}/api/chat`, { method: "OPTIONS" });
  if (!corsResponse.ok) {
    if (corsResponse.status === 403) throw new Error("Ollama 403：服务可达，但尚未授权此扩展发送翻译请求");
    throw new Error(`Ollama CORS ${corsResponse.status}`);
  }
  const data = await tagsResponse.json();
  return { ok: true, models: (data.models || []).map((model) => model.name) };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (["startBatch", "batchFrameReady", "batchItemDone", "batchControl", "batchStatus", "batchHistory", "openProgress", "ollamaStatus", "abortInference", "unloadModel"].includes(message.type)) {
    handleBatchMessage(message, _sender).then((result) => sendResponse({ ok: true, result })).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type !== "translate" && message.type !== "health") return false;
  const job = message.type === "translate" ? translate(message.items) : health();
  job.then((result) => sendResponse({ ok: true, result })).catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

async function getBatch() { return (await chrome.storage.local.get(BATCH_KEY))[BATCH_KEY] || null; }
async function archiveBatchHistory(batch) {
  const stored = await chrome.storage.local.get(BATCH_HISTORY_KEY);
  const cutoff = Date.now() - HISTORY_MAX_AGE_MS;
  const snapshot = { id: batch.id || `${batch.startedAt}:${batch.courseUrl}`, courseUrl: batch.courseUrl, model: batch.model, status: batch.status, phase: batch.phase, startedAt: batch.startedAt, finishedAt: batch.finishedAt || Date.now(), total: batch.total || 0, completed: batch.completed || 0, succeeded: batch.succeeded || 0, exercises: batch.exercises || 0, skipped: batch.skipped || 0, failed: batch.failed || 0, logs: batch.logs || [] };
  const history = [snapshot, ...(stored[BATCH_HISTORY_KEY] || []).filter((item) => item.id !== snapshot.id && (item.finishedAt || 0) >= cutoff)].slice(0, HISTORY_MAX_TASKS);
  await chrome.storage.local.set({ [BATCH_HISTORY_KEY]: history });
}
async function putBatch(batch) {
  batch.updatedAt = Date.now();
  if (["complete", "cancelled", "blocked"].includes(batch.status) && batch.historyArchivedStatus !== batch.status) {
    batch.finishedAt ||= Date.now(); batch.historyArchivedStatus = batch.status; await archiveBatchHistory(batch);
  }
  await chrome.storage.local.set({ [BATCH_KEY]: batch });
  const total = batch.total || 0, done = batch.completed || 0;
  const text = batch.status === "complete" ? "✓" : batch.status === "paused" ? "Ⅱ" : batch.status === "blocked" ? "!" : batch.status === "running" ? (batch.phase === "discovery" ? "找" : total ? `${Math.round(done / total * 100)}%` : "…") : "";
  await chrome.action.setBadgeBackgroundColor({ color: batch.status === "complete" ? "#188038" : batch.status === "running" ? "#d97706" : "#b3261e" });
  await chrome.action.setBadgeText({ text });
  return batch;
}
function batchLog(batch, text) { batch.logs = [...(batch.logs || []), { at: Date.now(), text }].slice(-200); }
function cleanUrl(value) { const url = new URL(value); url.searchParams.delete("iframe"); url.hash = ""; return url.href; }
function courseIdFromUrl(value) { return cleanUrl(value).match(/\/explore\/featured\/card\/([^/]+)\//)?.[1] || "unknown"; }
function chapterIdFromUrl(value) { return cleanUrl(value).match(/\/explore\/featured\/card\/[^/]+\/(\d+)\//)?.[1] || null; }

async function saveCourseCatalog(batch) {
  const courseId = courseIdFromUrl(batch.courseUrl);
  const scannedChapters = batch.chapters.map((chapter) => ({
    id: `${courseId}:chapter:${chapter.order}`, order: chapter.order, title: chapter.title, url: chapter.url,
    items: batch.items.filter((item) => item.chapterOrder === chapter.order).map((item) => ({
      id: item.id, order: item.order, title: item.title, url: item.url,
      type: item.status === "exercise" ? "Exercise" : item.type || "Item",
    })),
  }));
  const key = `llt:course:${courseId}`;
  const old = (await chrome.storage.local.get(key))[key] || {};
  const oldChapters = new Map((old.chapters || []).map((chapter) => [chapter.title, chapter]));
  const chapters = scannedChapters.map((chapter) => {
    const previous = oldChapters.get(chapter.title);
    const itemMap = new Map((previous?.items || []).map((item) => [item.id, item]));
    for (const item of chapter.items) itemMap.set(item.id, { ...itemMap.get(item.id), ...item });
    return { ...previous, ...chapter, items: [...itemMap.values()].sort((a, b) => a.order - b.order) };
  });
  const slug = courseId;
  const inferredTitle = slug.split("-").map((word) => word ? word[0].toUpperCase() + word.slice(1) : "").join(" ");
  await chrome.storage.local.set({ [key]: { ...old, courseId, slug, title: old.title || inferredTitle, chapters, updatedAt: Date.now() } });
}

async function navigateBatch(batch, url, delayMs) {
  clearTimeout(batchTimer);
  batch.waitingFor = cleanUrl(url); batch.nextAt = Date.now() + delayMs; await putBatch(batch);
  batchTimer = setTimeout(async () => {
    const latest = await getBatch();
    if (!latest || latest.status !== "running" || latest.waitingFor !== batch.waitingFor) return;
    try { await chrome.tabs.update(latest.tabId, { url: latest.waitingFor, active: false }); }
    catch (error) { latest.status = "paused"; latest.error = `批处理标签页不可用：${error.message}`; await putBatch(latest); }
    if (latest.phase === "discovery") {
      clearTimeout(discoveryTimer); const expectedIndex = latest.chapterIndex;
      discoveryTimer = setTimeout(async () => {
        const stalled = await getBatch();
        if (stalled?.status === "running" && stalled.phase === "discovery" && stalled.chapterIndex === expectedIndex) {
          const chapter = stalled.chapters[expectedIndex];
          const key = chapterIdFromUrl(chapter?.url) || String(expectedIndex);
          stalled.discoveryRetries ||= {};
          if (!(stalled.discoveryRetries[key] || 0)) {
            stalled.discoveryRetries[key] = 1;
            batchLog(stalled, `${chapter?.title || "未知章节"}：20 秒内未收到 iframe 目录，自动重新加载一次`);
            await putBatch(stalled);
            try { await chrome.tabs.reload(stalled.tabId); }
            catch (error) { stalled.status = "paused"; stalled.error = `重新加载批处理标签页失败：${error.message}`; await putBatch(stalled); return; }
            clearTimeout(discoveryTimer);
            discoveryTimer = setTimeout(async () => {
              const retried = await getBatch();
              if (retried?.status === "running" && retried.phase === "discovery" && retried.chapterIndex === expectedIndex) {
                retried.status = "blocked"; retried.phase = "diagnostic";
                retried.error = `章节“${chapter?.title || "未知"}”重新加载后 30 秒仍未识别到目录。可点击“继续”重新扫描当前章节。`;
                retried.current = "等待重新扫描"; batchLog(retried, retried.error); await putBatch(retried);
              }
            }, 30000);
            return;
          }
          stalled.status = "blocked"; stalled.phase = "diagnostic"; stalled.error = `章节“${chapter?.title || "未知"}”未识别到目录。可点击“继续”重新扫描当前章节。`;
          stalled.current = "等待重新扫描"; batchLog(stalled, stalled.error); await putBatch(stalled);
        }
      }, 20000);
    }
  }, delayMs);
}

async function startBatch(message) {
  const existing = await getBatch();
  if (["running", "paused", "blocked"].includes(existing?.status)) { await openProgress(); return existing; }
  const tab = await chrome.tabs.create({ url: message.courseUrl, active: false });
  if (message.model) await chrome.storage.sync.set({ model: message.model });
  const batch = { id: crypto.randomUUID(), version: 4, status: "running", phase: "overview", courseUrl: cleanUrl(message.courseUrl), tabId: tab.id, model: message.model || (await settings()).model, maxItems: Math.max(0, Number(message.maxItems || 0)), intervalMs: Math.max(3000, Number(message.intervalSeconds || 8) * 1000), startedAt: Date.now(), chapters: [], items: [], completed: 0, succeeded: 0, exercises: 0, skipped: 0, failed: 0, current: "读取课程目录", retries: {}, logs: [] };
  batchLog(batch, "任务已启动，正在读取课程首页"); await putBatch(batch);
  await openProgress();
  return batch;
}

async function openProgress() {
  const url = chrome.runtime.getURL("progress.html");
  const tabs = await chrome.tabs.query({ url: `${url}*` });
  if (tabs[0]?.id) return chrome.tabs.update(tabs[0].id, { active: true });
  return chrome.tabs.create({ url, active: true });
}

async function dispatchCommand(tabId, command) {
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: (detail) => document.dispatchEvent(new CustomEvent("llt-command", { detail })), args: [command] });
}

async function onBatchFrameReady(message, sender) {
  const batch = await getBatch();
  if (!batch || batch.status !== "running" || sender.tab?.id !== batch.tabId) return null;
  const pageUrl = cleanUrl(message.url);
  if (batch.phase === "overview" && message.frameKind === "overview" && message.chapterLinks?.length) {
    batch.chapters = message.chapterLinks.map((chapter, index) => ({ ...chapter, order: index, scanned: false }));
    batch.phase = "discovery"; batch.chapterIndex = 0; batch.current = batch.chapters[0]?.title || "扫描章节";
    batchLog(batch, `发现 ${batch.chapters.length} 个章节，开始建立完整目录`); await putBatch(batch);
    if (batch.chapters[0]) await navigateBatch(batch, batch.chapters[0].url, 1000);
    return batch;
  }
  if (batch.phase === "discovery" && message.frameKind === "chapter" && message.itemLinks?.length) {
    clearTimeout(discoveryTimer);
    const chapter = batch.chapters[batch.chapterIndex];
    if (!chapter || chapterIdFromUrl(pageUrl) !== chapterIdFromUrl(chapter.url)) return null;
    const seen = new Set(batch.items.map((item) => item.id));
    for (const item of message.itemLinks) if (!seen.has(item.id)) { batch.items.push({ ...item, chapterTitle: chapter.title, chapterOrder: chapter.order, status: "pending" }); seen.add(item.id); }
    chapter.scanned = true; chapter.itemCount = message.itemLinks.length; batch.chapterIndex++;
    batchLog(batch, `${chapter.title}：发现 ${message.itemLinks.length} 个条目`);
    const enoughForTest = batch.maxItems > 0 && batch.items.length >= batch.maxItems;
    if (!enoughForTest && batch.chapterIndex < batch.chapters.length) {
      batch.current = batch.chapters[batch.chapterIndex].title; await putBatch(batch); await navigateBatch(batch, batch.chapters[batch.chapterIndex].url, 2000);
    } else {
      batch.items.sort((a,b) => a.chapterOrder-b.chapterOrder || a.order-b.order); if (batch.maxItems) batch.items = batch.items.slice(0, batch.maxItems);
      if (!batch.items.length) { batch.status = "blocked"; batch.phase = "diagnostic"; batch.current = "未发现课程条目"; batch.error = "目录 iframe 已加载，但没有发现任何课程条目。任务已停止，没有执行翻译。"; batchLog(batch, batch.error); await putBatch(batch); return batch; }
      batch.phase = "translation"; batch.itemIndex = 0; batch.total = batch.items.length; batch.current = batch.items[0].title;
      batchLog(batch, `目录完成，共 ${batch.total} 个条目`); await saveCourseCatalog(batch); await putBatch(batch);
      if (batch.items[0]) await navigateBatch(batch, batch.items[0].url, batch.intervalMs); else { batch.status = "complete"; await putBatch(batch); }
    }
    return batch;
  }
  if (batch.phase === "translation" && message.articleReady) {
    const item = batch.items[batch.itemIndex];
    if (!item || pageUrl !== cleanUrl(item.url) || item.status === "working") return null;
    clearTimeout(articleTimer); item.status = "working"; item.startedAt = Date.now(); batch.current = item.title; await putBatch(batch);
    await dispatchCommand(batch.tabId, { type: "batchTranslate", batchItemId: item.id });
  } else if (batch.phase === "translation") {
    const item = batch.items[batch.itemIndex];
    if (item && pageUrl === cleanUrl(item.url) && item.status === "pending") {
      clearTimeout(articleTimer);
      // Normal problem links can be classified quickly. Quizzes sometimes
      // render their article content late, so give them the full readiness
      // window before deciding that they are link-only entries.
      const readinessMs = /\bquiz\b/i.test(item.title) ? 30000 : 6000;
      articleTimer = setTimeout(async () => {
        const latest = await getBatch(); const current = latest?.items?.[latest.itemIndex];
        if (latest?.status === "running" && current?.id === item.id && current.status === "pending") await onBatchItemDone({ itemId: item.id, status: "exercise", error: "练习题页面：不含课程讲义正文，已保留原始链接" }, { tab: { id: latest.tabId } });
      }, readinessMs);
    }
  }
  return batch;
}

async function onBatchItemDone(message, sender) {
  const batch = await getBatch();
  if (!batch || batch.status !== "running" || sender.tab?.id !== batch.tabId || batch.phase !== "translation") return null;
  const item = batch.items[batch.itemIndex]; if (!item || item.id !== message.itemId) return null;
  if (message.status === "failed") {
    const attempts = (batch.retries[item.id] || 0) + 1; batch.retries[item.id] = attempts;
    if (attempts <= 2) { item.status = "pending"; batchLog(batch, `重试 ${attempts}/2：${item.title} — ${message.error || "未知错误"}`); await putBatch(batch); await navigateBatch(batch, item.url, batch.intervalMs); return batch; }
  }
  item.status = message.status; item.finishedAt = Date.now(); item.error = message.error || ""; batch.completed++;
  if (message.status === "succeeded") batch.succeeded++; else if (message.status === "exercise") batch.exercises++; else if (message.status === "skipped") batch.skipped++; else batch.failed++;
  batchLog(batch, `${message.status === "succeeded" ? "完成" : message.status === "exercise" ? "练习题" : message.status === "skipped" ? "跳过" : "失败"}：${item.title}${message.error ? ` — ${message.error}` : ""}`);
  await saveCourseCatalog(batch);
  batch.itemIndex++;
  while (batch.items[batch.itemIndex] && batch.items[batch.itemIndex].status !== "pending") batch.itemIndex++;
  if (batch.itemIndex >= batch.items.length) { batch.status = "complete"; batch.phase = "complete"; batch.current = "全部完成"; batch.finishedAt = Date.now(); batchLog(batch, `任务完成：讲义 ${batch.succeeded}，练习题 ${batch.exercises || 0}，跳过 ${batch.skipped}，失败 ${batch.failed}`); await putBatch(batch); return batch; }
  batch.current = batch.items[batch.itemIndex].title; await putBatch(batch); await navigateBatch(batch, batch.items[batch.itemIndex].url, batch.intervalMs); return batch;
}

async function controlBatch(message) {
  const batch = await getBatch(); if (!batch) throw new Error("没有批处理任务");
  if (message.action === "pause") { const aborted = abortActiveRequests(); batch.status = "paused"; clearTimeout(batchTimer); batchLog(batch, `任务已暂停${aborted ? `，已中断 ${aborted} 个推理请求` : ""}`); }
  if (message.action === "resume") { if (batch.phase === "diagnostic" && batch.chapters?.[batch.chapterIndex]) { batch.phase = "discovery"; batch.error = ""; } batch.status = "running"; batchLog(batch, batch.phase === "discovery" ? "重新扫描当前章节" : "任务继续"); const url = batch.phase === "discovery" ? batch.chapters[batch.chapterIndex]?.url : batch.items[batch.itemIndex]?.url; await putBatch(batch); if (url) await navigateBatch(batch, url, 500); return batch; }
  if (message.action === "cancel") { const aborted = abortActiveRequests(); batch.status = "cancelled"; batch.finishedAt = Date.now(); clearTimeout(batchTimer); batchLog(batch, `任务已取消${aborted ? "，当前未完成批次未缓存" : ""}；此前完成的段落缓存、文章归档和课程目录均保留`); }
  if (message.action === "retryFailed") {
    if (batch.status === "running") throw new Error("请先等待当前任务结束或将其取消");
    const targets = (batch.items || []).filter((item) => item.status === "failed" || (item.status === "skipped" && /\bquiz\b/i.test(item.title)));
    if (!targets.length) throw new Error("没有需要重试的失败项");
    batch.items = targets.map((item) => ({ ...item, status: "pending", error: "" }));
    batch.id = crypto.randomUUID(); batch.historyArchivedStatus = null;
    batch.status = "running"; batch.phase = "translation"; batch.itemIndex = 0; batch.total = targets.length;
    batch.completed = 0; batch.succeeded = 0; batch.exercises = 0; batch.skipped = 0; batch.failed = 0;
    batch.retries = {}; batch.startedAt = Date.now(); batch.finishedAt = null; batch.error = ""; batch.current = batch.items[0].title;
    batchLog(batch, `仅重试 ${targets.length} 个失败项；已完成讲义继续使用本地缓存`);
    await putBatch(batch); await navigateBatch(batch, batch.items[0].url, 500); return batch;
  }
  await putBatch(batch); return batch;
}

async function handleBatchMessage(message, sender) {
  if (message.type === "startBatch") return startBatch(message);
  if (message.type === "batchFrameReady") return onBatchFrameReady(message, sender);
  if (message.type === "batchItemDone") return onBatchItemDone(message, sender);
  if (message.type === "batchControl") return controlBatch(message);
  if (message.type === "batchStatus") return getBatch();
  if (message.type === "batchHistory") return (await chrome.storage.local.get(BATCH_HISTORY_KEY))[BATCH_HISTORY_KEY] || [];
  if (message.type === "openProgress") return openProgress();
  if (message.type === "ollamaStatus") return ollamaStatus();
  if (message.type === "abortInference") return { aborted: abortActiveRequests() };
  if (message.type === "unloadModel") return unloadModel(message.model);
}

async function restoreBatchTimer() {
  const batch = await getBatch();
  if (!batch) return;
  if (["complete", "cancelled", "blocked"].includes(batch.status) && batch.historyArchivedStatus !== batch.status) { await putBatch(batch); return; }
  if (batch.status !== "running" || !batch.waitingFor) return;
  await navigateBatch(batch, batch.waitingFor, Math.max(250, (batch.nextAt || Date.now()) - Date.now()));
}
restoreBatchTimer().catch(() => {});
