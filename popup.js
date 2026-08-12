const status = document.querySelector("#status");
const modelSelect = document.querySelector("#model");
async function tab() { return (await chrome.tabs.query({ active: true, currentWindow: true }))[0]; }

async function ensurePageReady(current) {
  try {
    const reply = await chrome.tabs.sendMessage(current.id, { type: "status" });
    if (reply?.version === chrome.runtime.getManifest().version) return;
  } catch (error) {
    if (!String(error?.message || error).includes("Receiving end does not exist")) throw error;
  }

  await chrome.scripting.insertCSS({ target: { tabId: current.id, allFrames: true }, files: ["styles.css"] });
  await chrome.scripting.executeScript({ target: { tabId: current.id, allFrames: true }, files: ["content.js"] });
}

async function sendToPage(message) {
  const current = await tab();
  if (!current?.url?.startsWith("https://leetcode.com/explore/")) throw new Error("请打开 LeetCode Explore 页面");
  await ensurePageReady(current);
  return chrome.scripting.executeScript({
    target: { tabId: current.id, allFrames: true },
    func: (command) => document.dispatchEvent(new CustomEvent("llt-command", { detail: command })),
    args: [message]
  });
}
document.querySelector("#start").onclick = async () => {
  try { status.textContent = "正在连接当前页面…"; await sendToPage({ type: "start", mode: document.querySelector("#mode").value }); status.textContent = "已启动，请在页面右下角查看进度"; setTimeout(() => window.close(), 700); }
  catch (error) { status.textContent = `无法启动：${error.message}`; }
};
document.querySelector("#mode").onchange = () => sendToPage({ type: "mode", mode: document.querySelector("#mode").value }).catch(() => {});
function courseRoot(url) { return url?.match(/^(https:\/\/leetcode\.com\/explore\/featured\/card\/[^/]+\/)/)?.[1] || null; }
async function loadModels() { const saved=await chrome.storage.sync.get({model:"qwen3:8b"}); chrome.runtime.sendMessage({type:"health"},(reply)=>{ if(!reply?.ok){status.textContent=reply?.error||"模型读取失败";return;} modelSelect.replaceChildren(...reply.result.models.map(name=>new Option(name,name))); modelSelect.value=reply.result.models.includes(saved.model)?saved.model:reply.result.models[0]; }); }
modelSelect.onchange=()=>chrome.storage.sync.set({model:modelSelect.value}); loadModels();
async function startCourse(maxItems) { const current=await tab(), root=courseRoot(current?.url); if(!root){status.textContent="请先打开任意 LeetCode Explore 课程页面";return;} status.textContent=maxItems?"正在启动 2 篇验证任务…":"正在启动完整课程任务…"; chrome.runtime.sendMessage({type:"startBatch",courseUrl:root,model:modelSelect.value,intervalSeconds:Number(document.querySelector("#interval").value),maxItems},(reply)=>{status.textContent=reply?.ok?"任务已创建，进度页已打开":reply?.error||"启动失败";}); }
document.querySelector("#testBatch").onclick=()=>startCourse(2);
document.querySelector("#fullBatch").onclick=()=>startCourse(0);
document.querySelector("#openProgress").onclick=()=>chrome.runtime.sendMessage({type:"openProgress"});
function refreshBatchStatus(){chrome.runtime.sendMessage({type:"batchStatus"},(reply)=>{const b=reply?.result;if(!b)return;status.textContent=`${b.status} · ${b.phase} · ${b.completed||0}/${b.total||0} · ${b.current||""}`;});}
refreshBatchStatus(); setInterval(refreshBatchStatus,1000);
document.querySelector("#exportCurrent").onclick = () => sendToPage({ type: "exportCurrent" }).then(() => window.close()).catch((e) => status.textContent = e.message);
document.querySelector("#exportLibrary").onclick = async () => {
  const button = document.querySelector("#exportLibrary");
  try {
    button.disabled = true; status.textContent = "正在整理浏览器中的课程归档…";
    const current = await tab();
    if (!current?.url?.startsWith("https://leetcode.com/explore/")) throw new Error("请先打开任意 LeetCode Explore 页面");
    await ensurePageReady(current);
    const reply = await chrome.tabs.sendMessage(current.id, { type: "exportLibraryRequest" });
    if (!reply?.ok) throw new Error(reply?.error || "导出命令没有返回结果");
    const result = reply.result;
    status.textContent = `已生成 ${result.pageCount} 篇讲义：${result.markdownName} 和 ${result.htmlName}`;
  } catch (error) {
    status.textContent = `导出失败：${error.message}`;
  } finally {
    button.disabled = false;
  }
};
