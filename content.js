const CONTENT_VERSION = "0.8.0";
const STATE = { running: false, enabled: false, mode: "bilingual", abort: 0, lastUrl: location.href, rerunTimer: 0 };
const SKIP = "pre, code, kbd, samp, script, style, textarea, input, select, button, nav, header, footer, [contenteditable='true'], [class*='monaco'], [class*='CodeMirror'], .llt-translation";
const BLOCKS = "h1, h2, h3, h4, p, li, blockquote, figcaption, td, th";

function rootNode() {
  const article = document.querySelector(".article-inner .block-markdown, .article-inner");
  if (article) return article;
  const candidates = [...document.querySelectorAll("article, main, [role='main']")];
  return candidates.sort((a, b) => b.innerText.length - a.innerText.length)[0] || document.body;
}

function isArticleFrame() {
  return Boolean(document.querySelector(".article-inner .block-markdown, .article-inner"));
}

function isEligible(element) {
  if (element.closest(SKIP) || element.dataset.lltDone === "1") return false;
  const text = element.innerText.trim();
  if (text.length < 2 || text.length > 6000) return false;
  if ([...element.children].some((child) => child.matches(BLOCKS))) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && getComputedStyle(element).visibility !== "hidden";
}

function collect() {
  return [...rootNode().querySelectorAll(BLOCKS)].filter(isEligible);
}

function protectedNodes(element) {
  return [...element.querySelectorAll("code, math, .katex")].filter((node) => !node.parentElement?.closest("code, math, .katex"));
}

function prepare(element) {
  const clone = element.cloneNode(true);
  const originals = protectedNodes(element);
  protectedNodes(clone).forEach((node, index) => node.replaceWith(document.createTextNode(`⟦LLT${index}⟧`)));
  return { text: clone.textContent.replace(/\s+/g, " ").trim(), protected: originals };
}

async function digest(text, signature) {
  const bytes = new TextEncoder().encode(`v2:${signature}:${text}`);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function storageSet(values) {
  return new Promise((resolve) => chrome.storage.local.set(values, resolve));
}

function send(message) {
  return new Promise((resolve, reject) => chrome.runtime.sendMessage(message, (reply) => {
    if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
    if (!reply?.ok) return reject(new Error(reply?.error || "Translation failed"));
    resolve(reply.result);
  }));
}

function progress(message, kind = "working") {
  let node = document.querySelector("#llt-progress");
  if (!node) {
    node = document.createElement("div");
    node.id = "llt-progress";
    document.documentElement.appendChild(node);
  }
  node.dataset.kind = kind;
  node.textContent = message;
  node.hidden = false;
  if (kind === "done") setTimeout(() => { node.hidden = true; }, 3000);
}

function appendRichText(output, text, protectedItems) {
  output.replaceChildren();
  const parts = text.split(/(⟦LLT\d+⟧)/g);
  for (const part of parts) {
    const match = part.match(/^⟦LLT(\d+)⟧$/);
    if (match && protectedItems[Number(match[1])]) output.appendChild(protectedItems[Number(match[1])].cloneNode(true));
    else output.appendChild(document.createTextNode(part));
  }
}

function render(element, text, key, protectedItems = []) {
  let output = element.nextElementSibling;
  if (!output?.classList.contains("llt-translation")) {
    output = document.createElement("div");
    output.className = "llt-translation";
    output.setAttribute("lang", "zh-CN");
    element.insertAdjacentElement("afterend", output);
  }
  appendRichText(output, text, protectedItems);
  output.dataset.lltKey = key;
  output.dataset.lltLoading = "false";
  element.dataset.lltDone = "1";
  element.classList.toggle("llt-original-hidden", STATE.mode === "translated");
}

function articleTitle() {
  const article = document.querySelector(".article-inner");
  const heading = article?.querySelector("h1, h2, .article-title, [class*='article-title']");
  const lines = (heading?.innerText || article?.innerText || "LeetCode Explore").split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.find((line) => !/^(Report Issue|Previous|Next)$/i.test(line)) || "LeetCode Explore";
}

function canonicalUrl(value = location.href) {
  const url = new URL(value); url.searchParams.delete("iframe"); url.hash = ""; return url.href;
}

function courseInfo() {
  const match = canonicalUrl().match(/\/explore\/featured\/card\/([^/]+)\/(\d+)\/([^/]+)\/(\d+)\/?/);
  return match ? { slug: match[1], cardId: match[2], pathChapter: match[3], pageId: match[4] } : { slug: "leetcode-explore", cardId: "unknown", pathChapter: "unknown", pageId: location.pathname.replace(/\/$/, "").split("/").pop() };
}

function navigationSnapshot() {
  const info = courseInfo();
  const chapters = [...document.querySelectorAll(".chapter-item")].map((chapter, index) => {
    const titleNode = chapter.querySelector(":scope > div, :scope > a") || chapter;
    const title = (titleNode.innerText || "").split("\n")[0].trim();
    const items = [...chapter.querySelectorAll(".item-list-group a[href*='/explore/featured/card/']")].map((link, itemIndex) => {
      const url = canonicalUrl(link.href); const id = url.replace(/\/$/, "").split("/").pop();
      const iconTitle = link.querySelector("[title]")?.getAttribute("title") || "";
      return { id, order: itemIndex, title: link.innerText.trim(), url, type: iconTitle || (link.innerText.includes("quiz") ? "Quiz" : "Item") };
    });
    return { id: `${info.cardId}:chapter:${index}`, order: index, title, items };
  }).filter((chapter) => chapter.title);
  const active = chapters.find((chapter) => chapter.items.some((item) => item.id === info.pageId));
  return { courseId: info.cardId, slug: info.slug, title: info.slug.split("-").map((word) => word[0]?.toUpperCase() + word.slice(1)).join(" "), chapters, activeChapterId: active?.id || null };
}

function overviewChapterLinks() {
  return [...document.querySelectorAll("a.chapter-list-item[href*='/explore/featured/card/']")].filter((link) => !link.classList.contains("active")).map((link) => ({ title: link.innerText.split("\n")[0].trim(), url: canonicalUrl(link.href) }));
}

function currentChapterItems() {
  const info = courseInfo();
  const links = [...document.querySelectorAll(".chapter-content .explore-item-list a[href*='/explore/featured/card/'], .chapter-item .item-list-group a[href*='/explore/featured/card/']")];
  return links.map((link, order) => { const url = canonicalUrl(link.href); return { id: url.replace(/\/$/, "").split("/").pop(), order, title: link.innerText.trim(), url, type: link.querySelector("[title]")?.getAttribute("title") || "Item", chapterPath: info.pathChapter }; });
}

function announceBatchFrame() {
  const chapterLinks = overviewChapterLinks(); const itemLinks = currentChapterItems(); const articleReady = isArticleFrame();
  const frameKind = itemLinks.length ? "chapter" : chapterLinks.length ? "overview" : articleReady ? "article" : "irrelevant";
  if (frameKind === "irrelevant") return false;
  chrome.runtime.sendMessage({ type: "batchFrameReady", frameKind, url: canonicalUrl(), chapterLinks, itemLinks, articleReady }).catch(() => {});
  return true;
}

async function mergeNavigation() {
  const incoming = navigationSnapshot();
  const key = `llt:course:${incoming.courseId}`;
  const old = (await storageGet([key]))[key];
  if (old) {
    const byTitle = new Map(old.chapters.map((chapter) => [chapter.title, chapter]));
    incoming.chapters = incoming.chapters.map((chapter) => {
      const previous = byTitle.get(chapter.title);
      return { ...chapter, items: chapter.items.length ? chapter.items : (previous?.items || []) };
    });
  }
  await storageSet({ [key]: { ...incoming, updatedAt: Date.now() } });
  return incoming;
}

function mathText(node) {
  return node.querySelector?.('annotation[encoding="application/x-tex"]')?.textContent?.trim() || node.textContent.replace(/\s+/g, " ").trim();
}

function markdownInline(node) {
  const clone = node.cloneNode(true);
  protectedNodes(clone).forEach((item) => {
    const value = item.matches("code") ? `\`${item.textContent}\`` : `$${mathText(item)}$`;
    item.replaceWith(document.createTextNode(value));
  });
  return clone.textContent.replace(/\s+/g, " ").trim();
}

function buildArchive() {
  const title = articleTitle();
  const info = courseInfo();
  const blocks = [...rootNode().querySelectorAll(BLOCKS)].filter((element) => element.dataset.lltDone === "1");
  const markdown = [`# ${title}`, "", `> Source: ${canonicalUrl()}`, `> Saved: ${new Date().toISOString()}`, ""];
  const htmlBlocks = [];
  for (const element of blocks) {
    const translation = element.nextElementSibling?.classList.contains("llt-translation") ? element.nextElementSibling : null;
    if (!translation) continue;
    const original = markdownInline(element);
    const translated = markdownInline(translation);
    const prefix = /^H[1-4]$/.test(element.tagName) ? `${"#".repeat(Number(element.tagName[1]) + 1)} ` : element.tagName === "LI" ? "- " : element.tagName === "BLOCKQUOTE" ? "> " : "";
    markdown.push(`${prefix}${original}`, "", `${prefix}${translated}`, "");
    htmlBlocks.push(`<section class="pair"><div class="original">${element.outerHTML}</div><div class="translation">${translation.innerHTML}</div></section>`);
  }
  const printCss = `@page{size:A4;margin:18mm 16mm 20mm}*{box-sizing:border-box}body{font:16px/1.75 -apple-system,BlinkMacSystemFont,"Noto Sans CJK SC","PingFang SC",sans-serif;max-width:920px;margin:42px auto;padding:0 28px;color:#202124}h1{font-size:2.15rem;line-height:1.25;margin:0 0 .5em}h2,h3{break-after:avoid}.meta{font-size:12px;color:#777;border-bottom:1px solid #ddd;padding-bottom:16px}.pair{margin:1.6em 0;break-inside:avoid}.original{color:#555}.translation{margin-top:.65em;padding:.8em 1.05em;border-left:3px solid #d98300;background:#fff8ed}code{font-family:"SFMono-Regular",Consolas,monospace;background:#f3f4f6;padding:.08em .28em;border-radius:4px}pre{overflow:auto;background:#f5f5f5;padding:1em;white-space:pre-wrap}img,svg{max-width:100%}a{color:#245faa;text-decoration:none}nav{break-after:page}nav li{margin:.35em 0}.chapter-page{break-before:page}@media print{body{margin:0;padding:0;font-size:10.5pt}.pair{break-inside:auto}.translation,pre,blockquote,table{break-inside:avoid}a{color:inherit}.meta{font-size:8.5pt}}`;
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title.replace(/[<>&]/g, "")}</title><style>${printCss}</style></head><body><main><h1>${title.replace(/[<>&]/g, "")}</h1><p class="meta">来源：${canonicalUrl()}<br>归档时间：${new Date().toLocaleString()}</p>${htmlBlocks.join("\n")}</main></body></html>`;
  return { id: info.pageId, courseId: info.cardId, chapterPath: info.pathChapter, title, url: canonicalUrl(), savedAt: Date.now(), blockCount: htmlBlocks.length, markdown: markdown.join("\n"), html };
}

function safeName(value) { return value.replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trim().slice(0, 100) || "leetcode-explore"; }

function downloadText(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function archiveCurrent() {
  const page = buildArchive();
  if (!page.blockCount) throw new Error("请先完成当前页面翻译");
  await storageSet({ [`llt:page:${page.id}`]: page });
  await mergeNavigation();
  return page;
}

async function exportCurrent() {
  const page = await archiveCurrent();
  const name = safeName(page.title);
  downloadText(`${name}.md`, page.markdown, "text/markdown;charset=utf-8");
  downloadText(`${name}.html`, page.html, "text/html;charset=utf-8");
  progress("已保存当前章节：Markdown + HTML", "done");
}

async function exportLibrary() {
  const stored = await storageGet(null);
  const pages = Object.entries(stored).filter(([key]) => key.startsWith("llt:page:")).map(([, value]) => value).sort((a, b) => a.savedAt - b.savedAt);
  if (!pages.length) throw new Error("归档为空；先翻译并保存至少一个章节");
  const course = Object.entries(stored).find(([key]) => key.startsWith("llt:course:"))?.[1];
  const pageById = new Map(pages.map((page) => [page.id, page]));
  const tocMd = course ? ["# 课程目录", "", ...course.chapters.flatMap((chapter) => [`## ${chapter.title}`, "", ...chapter.items.map((item) => `- ${pageById.has(item.id) ? "[已归档]" : "[未归档]"} ${item.title}`), ""])] : [];
  const ordered = course ? course.chapters.flatMap((chapter) => chapter.items.map((item) => pageById.get(item.id)).filter(Boolean)) : pages;
  const extras = pages.filter((page) => !ordered.some((orderedPage) => orderedPage.id === page.id));
  const finalPages = [...ordered, ...extras];
  const md = [...tocMd, ...finalPages.map((page) => page.markdown)].join("\n\n---\n\n");
  const tocHtml = course ? `<nav><h1>课程目录</h1>${course.chapters.map((chapter) => `<h2>${chapter.title}</h2><ul>${chapter.items.map((item) => `<li>${pageById.has(item.id) ? "✓" : "○"} ${item.title}</li>`).join("")}</ul>`).join("")}</nav><div style="break-before:page"></div>` : "";
  const body = tocHtml + finalPages.map((page) => page.html.match(/<body>([\s\S]*)<\/body>/)?.[1] || "").join('<div style="break-before:page"></div>');
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>LeetCode Explore 双语讲义</title><style>@page{size:A4;margin:18mm 16mm 20mm}*{box-sizing:border-box}body{font:16px/1.75 -apple-system,BlinkMacSystemFont,"Noto Sans CJK SC","PingFang SC",sans-serif;max-width:920px;margin:42px auto;padding:0 28px;color:#202124}.cover{min-height:75vh;display:grid;place-content:center;text-align:center;break-after:page}.cover h1{font-size:2.6rem}.cover p{color:#777}nav{break-after:page}nav h2{margin-top:1.4em}nav li{margin:.35em 0}.translation{margin:.65em 0 1.5em;padding:.8em 1.05em;border-left:3px solid #d98300;background:#fff8ed}code{font-family:"SFMono-Regular",Consolas,monospace;background:#f3f4f6;padding:.08em .28em;border-radius:4px}pre{white-space:pre-wrap;background:#f5f5f5;padding:1em}.pair{break-inside:auto}img,svg{max-width:100%}@media print{body{margin:0;padding:0;font-size:10.5pt}.translation,pre,blockquote,table{break-inside:avoid}}</style></head><body><header class="cover"><div><h1>LeetCode Explore 双语讲义</h1><p>本地模型翻译 · 个人学习归档</p><p>${new Date().toLocaleDateString()}</p></div></header>${body}</body></html>`;
  downloadText("leetcode-explore-archive.md", md, "text/markdown;charset=utf-8");
  downloadText("leetcode-explore-archive.html", html, "text/html;charset=utf-8");
  progress(`已导出 ${pages.length} 个已访问章节`, "done");
}

function batches(entries, maxChars = 5500, maxItems = 12) {
  const result = [];
  let batch = [], size = 0;
  for (const entry of entries) {
    if (batch.length && (batch.length >= maxItems || size + entry.text.length > maxChars)) {
      result.push(batch); batch = []; size = 0;
    }
    batch.push(entry); size += entry.text.length;
  }
  if (batch.length) result.push(batch);
  return result;
}

async function run() {
  if (STATE.running) return;
  STATE.running = true;
  const token = ++STATE.abort;
  try {
    progress("正在识别 LeetCode 正文…");
    const elements = collect();
    if (!elements.length) throw new Error("没有识别到可翻译的正文，请等待页面加载完成后重试");
    const config = await chrome.storage.sync.get({ model: "qwen3:8b", targetLanguage: "Simplified Chinese" });
    const signature = `${config.model}:${config.targetLanguage}`;
    const entries = await Promise.all(elements.map(async (element) => { const rich = prepare(element); return { element, ...rich, id: await digest(rich.text, signature) }; }));
    const cached = await storageGet(entries.map((entry) => `llt:${entry.id}`));
    const missing = [];
    for (const entry of entries) {
      const value = cached[`llt:${entry.id}`];
      if (value) render(entry.element, value, entry.id, entry.protected);
      else missing.push(entry);
    }
    const pendingBatches = batches(missing);
    let batchIndex = 0;
    for (const batch of pendingBatches) {
      if (token !== STATE.abort) break;
      batchIndex++;
      progress(`本地模型翻译中：第 ${batchIndex}/${pendingBatches.length} 批（已缓存 ${entries.length - missing.length} 段）`);
      const translated = await send({ type: "translate", items: batch.map(({ id, text }) => ({ id, text })) });
      const byId = new Map(translated.map((item) => [item.id, item.text]));
      const writes = {};
      for (const entry of batch) {
        const value = byId.get(entry.id);
        if (!value) continue;
        render(entry.element, value, entry.id, entry.protected);
        writes[`llt:${entry.id}`] = value;
      }
      await storageSet(writes);
    }
    await archiveCurrent();
    progress(`翻译完成：共 ${document.querySelectorAll(".llt-translation").length} 段`, "done");
    chrome.runtime.sendMessage({ type: "pageStatus", count: document.querySelectorAll(".llt-translation").length }).catch(() => {});
  } catch (error) {
    console.error("[LeetCode Local Translator]", error);
    const invalidated = /Extension context invalidated/i.test(error.message);
    progress(invalidated ? "扩展刚刚被重新加载，请刷新此 LeetCode 页面后再翻译" : `本地翻译失败：${error.message}`, "error");
    throw error;
  } finally {
    STATE.running = false;
  }
}

async function runBatch(itemId) {
  try {
    STATE.enabled = true; await run();
    const count = document.querySelectorAll(".llt-translation").length;
    await chrome.runtime.sendMessage({ type: "batchItemDone", itemId, status: count ? "succeeded" : "skipped", error: count ? "" : "未识别到可归档正文" });
  } catch (error) {
    await chrome.runtime.sendMessage({ type: "batchItemDone", itemId, status: "failed", error: error.message });
  }
}

function removeTranslations() {
  STATE.abort++;
  document.querySelectorAll(".llt-translation").forEach((node) => node.remove());
  document.querySelectorAll("[data-llt-done]").forEach((node) => {
    delete node.dataset.lltDone;
    node.classList.remove("llt-original-hidden");
  });
}

function handleCommand(message) {
  // LeetCode renders Explore articles in a same-origin iframe. Ignore the
  // outer navigation document and nested video/editor frames.
  if (!isArticleFrame()) return;
  if (message.type === "start") { STATE.enabled = true; STATE.mode = message.mode || STATE.mode; run().catch(() => {}); }
  if (message.type === "mode") {
    STATE.mode = message.mode;
    document.querySelectorAll("[data-llt-done]").forEach((node) => node.classList.toggle("llt-original-hidden", STATE.mode === "translated"));
  }
  if (message.type === "remove") { STATE.enabled = false; removeTranslations(); }
  if (message.type === "exportCurrent") exportCurrent().catch((error) => progress(`保存失败：${error.message}`, "error"));
  if (message.type === "exportLibrary") exportLibrary().catch((error) => progress(`导出失败：${error.message}`, "error"));
  if (message.type === "batchTranslate") runBatch(message.batchItemId);
}

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  handleCommand(message);
  if (message.type === "status") respond({ version: CONTENT_VERSION, count: document.querySelectorAll(".llt-translation").length, running: STATE.running });
  return false;
});

document.addEventListener("llt-command", (event) => handleCommand(event.detail || {}));

setInterval(() => {
  if (location.href !== STATE.lastUrl) {
    STATE.lastUrl = location.href;
    removeTranslations();
    if (STATE.enabled) setTimeout(() => run().catch(() => {}), 900);
  }
}, 800);

new MutationObserver((mutations) => {
  if (!STATE.enabled || !mutations.some((mutation) => [...mutation.addedNodes].some((node) => node.nodeType === Node.ELEMENT_NODE && !node.classList?.contains("llt-translation")))) return;
  clearTimeout(STATE.rerunTimer);
  STATE.rerunTimer = setTimeout(() => run().catch(() => {}), 700);
}).observe(document.documentElement, { childList: true, subtree: true });

let batchAnnounceAttempts = 0;
const batchAnnounceTimer = setInterval(() => {
  batchAnnounceAttempts++;
  if (announceBatchFrame() || batchAnnounceAttempts >= 20) clearInterval(batchAnnounceTimer);
}, 500);
