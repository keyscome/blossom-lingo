const defaults = { endpoint: "http://127.0.0.1:11434", model: "qwen3:8b", targetLanguage: "Simplified Chinese", temperature: 0.1 };
const extensionOrigin = `chrome-extension://${chrome.runtime.id}`;
document.querySelector("#extensionOrigin").value = extensionOrigin;
document.querySelector("#setupCommand").value = `launchctl setenv OLLAMA_ORIGINS "${extensionOrigin}"`;
document.querySelector("#copyCommand").onclick = async () => {
  await navigator.clipboard.writeText(document.querySelector("#setupCommand").value);
  document.querySelector("#copyCommand").textContent = "已复制";
  setTimeout(() => document.querySelector("#copyCommand").textContent = "复制命令", 1500);
};
chrome.storage.sync.get(defaults, (values) => Object.entries(values).forEach(([key, value]) => { const input = document.querySelector(`#${key}`); if (input) input.value = value; }));
document.querySelector("#save").onclick = async () => {
  const values = Object.fromEntries(Object.keys(defaults).map((key) => [key, document.querySelector(`#${key}`).value]));
  values.temperature = Number(values.temperature);
  await chrome.storage.sync.set(values);
  document.querySelector("#saved").textContent = "已保存";
  setTimeout(() => document.querySelector("#saved").textContent = "", 1500);
};
