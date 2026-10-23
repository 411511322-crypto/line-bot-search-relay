// LINE bot 的「本地模型轉接站」：讓雲端的 Apps Script 叫得到你電腦上的 Ollama，而且會上網搜
//
// 為什麼要這支：LINE bot 的程式跑在 Google 的機房，不在你的電腦上——
// 它說 localhost，是指 Google 那台機器自己，找不到你電腦裡的 Ollama。
// 所以要兩樣東西接起來：
//   ① 這支小程式：在你電腦上等問題，替模型跑搜尋，要「通關密碼」才回答
//   ② Cloudflare 通道（cloudflared）：給這支小程式一個外面連得到的 https 網址
//
// 一則問題的旅程：
//   手機傳「查 …」→ LINE → Apps Script → 通道網址 → 這支程式（對密碼）
//   → Ollama 模型自己決定要不要搜 → Ollama 內建的搜尋（web_search／web_fetch）→ 回答＋真的來源網址
//
// 需要：Ollama 開著、已 pull gemma4:e4b；Node.js（W6 第 0 段裝過）；cloudflared（沒有也能跑，只是外面連不到）
// 用法（PowerShell，在這個檔所在的資料夾）：
//   node line-search-relay.mjs              開轉接站＋自動開通道，印出網址（密碼只放剪貼簿、不顯示）
//   node line-search-relay.mjs --no-tunnel  只開轉接站（自己在本機測）
// 不用 npm install 任何套件，只用 Node.js 內建的功能。

import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ===== 1. 設定（想換就在 PowerShell 先設環境變數，例如 $env:MODEL="gemma4:e2b"） =====
const MODEL = process.env.MODEL || "gemma4:e4b";
const PORT = Number(process.env.PORT || 8787);
const OLLAMA = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const BUDGET_MS = 45000;  // LINE 的回覆碼只能用一次、很快就失效（官方沒給秒數），扣掉 Apps Script 自己的時間，最多想 45 秒
const MAX_ROUNDS = 4;     // 模型最多來回呼叫工具幾次
const KEY_FILE = join(homedir(), ".line-search-relay.key");  // 密碼存在家目錄，重開程式還是同一組（不放進專案資料夾，免得被 git 帶走）
const WANT_TUNNEL = !process.argv.includes("--no-tunnel");

function loadKey() {
  if (process.env.RELAY_KEY) return process.env.RELAY_KEY;
  if (existsSync(KEY_FILE)) return readFileSync(KEY_FILE, "utf8").trim();
  const key = randomBytes(18).toString("base64url");
  writeFileSync(KEY_FILE, key);
  return key;
}
const KEY = loadKey();

function today() {
  return new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Taipei", dateStyle: "full" }).format(new Date());
}

// 系統提示：日期可能在模型訓練之後，所以不確定就先搜（同 starter/Modelfile 的那段規矩）
function systemPrompt() {
  return `你是 LINE 上的查詢助理。今天是 ${today()}（台北時間），可能比你的訓練資料新。
你有 web_search 與 web_fetch 兩個工具。遇到最近的事、日期在你知識之後的事、版本號、價格，或任何你不確定的事實，先呼叫 web_search；搜尋結果不夠明確時，用 web_fetch 讀官方頁面確認。不要以「還沒發生」為由拒絕查詢。
回答用台灣的繁體中文用語（例如「微中子」不寫「中微子」）、純文字（不要用 Markdown 的星號或井字號），150 字以內，先講結論。
不用自己寫網址，程式會附上你實際查到的來源。查不到就老實說查不到。`;
}

const TOOLS = [
  { type: "function", function: { name: "web_search", description: "搜尋網路，回傳前幾筆的標題、網址與內文摘要。",
    parameters: { type: "object", properties: { query: { type: "string", description: "搜尋關鍵字" } }, required: ["query"] } } },
  { type: "function", function: { name: "web_fetch", description: "讀取一個網頁的主要文字。",
    parameters: { type: "object", properties: { url: { type: "string", description: "要讀的網址" } }, required: ["url"] } } }
];


// ===== 2. 叫 Ollama：模型本身、還有 Ollama 內建的搜尋 =====
async function ollama(path, body, signal) {
  const res = await fetch(OLLAMA + path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Ollama ${path} 回應 ${res.status}：${text.slice(0, 150)}`);
  return JSON.parse(text);
}

// 搜尋結果的內文可能很長，截短再給模型，免得塞爆它的記憶（num_ctx）
async function webSearch(query, signal, sources) {
  const data = await ollama("/api/experimental/web_search", { query, max_results: 3 }, signal);
  const rows = (data.results || []).map(r => ({ title: r.title, url: r.url, content: String(r.content || "").slice(0, 1500) }));
  rows.forEach(r => sources.push({ title: r.title, url: r.url }));
  return JSON.stringify(rows);
}

async function webFetch(url, signal, sources) {
  const data = await ollama("/api/experimental/web_fetch", { url }, signal);
  sources.unshift({ title: data.title || url, url });  // 模型特地去讀的那頁，排在來源最前面
  return JSON.stringify({ title: data.title, content: String(data.content || "").slice(0, 3000) });
}

async function answer(question) {
  const signal = AbortSignal.timeout(BUDGET_MS);
  const t0 = Date.now();
  const messages = [{ role: "system", content: systemPrompt() }, { role: "user", content: question }];
  const queries = [], sources = [];
  let reply = "";
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const data = await ollama("/api/chat", {
      model: MODEL, messages, tools: TOOLS, stream: false, think: false,
      keep_alive: "1h", options: { num_ctx: 16384 }
    }, signal);
    const msg = data.message || {};
    messages.push(msg);
    const calls = msg.tool_calls || [];
    if (!calls.length) { reply = msg.content || ""; break; }
    for (const c of calls) {
      const fn = c.function.name, args = c.function.arguments || {};
      let out;
      try {
        if (fn === "web_search") {
          log(`  🔍 模型決定搜：${args.query}`);
          queries.push(args.query);
          out = await webSearch(args.query, signal, sources);
        } else if (fn === "web_fetch") {
          log(`  📄 模型決定讀網頁：${args.url}`);
          out = await webFetch(args.url, signal, sources);
        } else {
          out = `ERROR: 沒有 ${fn} 這個工具`;
        }
      } catch (err) {
        if (signal.aborted) throw err;
        out = `ERROR: ${err.message}`;
      }
      messages.push({ role: "tool", tool_name: fn, content: out });
    }
  }
  if (!reply) reply = "查了幾次還整理不出答案，換個問法再試一次。";
  const seen = new Set();
  const unique = sources.filter(s => s.url && !seen.has(s.url) && seen.add(s.url)).slice(0, 3);
  return {
    answer: reply.replace(/\*\*|__|^#+\s*|`/gm, "").trim().slice(0, 600),
    searched: queries.length > 0 || unique.length > 0,
    queries, sources: unique,
    seconds: Math.round((Date.now() - t0) / 1000)
  };
}


// ===== 3. 轉接站本身：只回答帶對密碼的請求 =====
function log(s) {
  const t = new Date().toLocaleTimeString("zh-TW", { hour12: false, timeZone: "Asia/Taipei" });
  console.log(`[${t}] ${s}`);
}

function keyMatches(given) {
  const a = Buffer.from(String(given || "")), b = Buffer.from(KEY);
  return a.length === b.length && timingSafeEqual(a, b);
}

function send(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

let busy = false;  // 顯示卡一次只答一題；同時來第二題就請它等一下

const server = http.createServer(async (req, res) => {
  const path = (req.url || "/").split("?")[0];
  if (req.method === "GET" && (path === "/" || path === "/health")) {
    return send(res, 200, { ok: true, service: "line-search-relay", model: MODEL });  // 給瀏覽器確認活著，不需要密碼
  }
  const isCheck = req.method === "GET" && path === "/check-key";  // testSetup 用：只對密碼、不叫模型
  if (!isCheck && (req.method !== "POST" || path !== "/ask")) return send(res, 404, { error: "只有 POST /ask" });
  if (!keyMatches(req.headers["x-relay-key"])) {
    log(isCheck ? "⛔ 有人來對密碼，但密碼不對" : "⛔ 有人來問，但密碼不對，拒絕");
    return send(res, 401, { error: "密碼不對" });
  }
  if (isCheck) return send(res, 200, { ok: true, model: MODEL });
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 20000) return send(res, 413, { error: "問題太長" });
  }
  let question = "";
  try { question = String(JSON.parse(raw || "{}").question || "").trim(); } catch (e) { /* 下面一起處理 */ }
  if (!question) return send(res, 400, { error: "沒有收到問題（JSON 要有 question 欄位）" });
  if (busy) return send(res, 429, { error: "正在回答上一題，等一下再問" });

  busy = true;
  log(`📩 收到一題（${question.length} 字）`);  // 不把問題內容印出來：螢幕可能正在投影
  try {
    const result = await answer(question);
    log(`✅ 回答好了（${result.seconds} 秒，${result.searched ? "有上網查" : "沒有上網查"}）`);
    send(res, 200, result);
  } catch (err) {
    const timeout = err.name === "TimeoutError" || err.name === "AbortError";
    log(`❌ ${timeout ? "超過 45 秒，放棄這題" : err.message}`);
    send(res, timeout ? 504 : 502, { error: timeout ? "想太久了（超過 45 秒），換個簡單一點的問法" : err.message });
  } finally {
    busy = false;
  }
});


// ===== 4. 開機：先把模型載進顯示卡，再開通道 =====
async function warmUp() {
  log(`載入模型 ${MODEL}（第一次要等一兩分鐘，之後每題幾秒）…`);
  const t0 = Date.now();
  try {
    // num_ctx 要跟答題時一樣，不然第一題又會重新載入一次模型
    await ollama("/api/chat", { model: MODEL, messages: [], keep_alive: "1h", options: { num_ctx: 16384 } }, AbortSignal.timeout(300000));
    log(`✅ 模型已在顯示卡上（${Math.round((Date.now() - t0) / 1000)} 秒）`);
    return true;
  } catch (err) {
    log(`⚠️ 模型沒載起來：${err.message}`);
    log("   先確認 Ollama app 開著、ollama list 看得到 " + MODEL);
    return false;
  }
}

function hasCloudflared() {
  try { execFileSync("cloudflared", ["--version"], { stdio: "ignore" }); return true; } catch (e) { return false; }
}

function startTunnel() {
  if (!hasCloudflared()) {
    log("⚠️ 找不到 cloudflared：外面還連不到這裡。照互動頁第 0 段 C：把 cloudflared.exe 下載到 line-relay 資料夾，");
    log("   然後在這個視窗貼  $env:PATH += \";$env:USERPROFILE\\line-relay\"  ，關掉本程式再跑一次。");
    return;
  }
  log("開 Cloudflare 通道中（免帳號的臨時網址，每次重開都會換）…");
  const cf = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${PORT}`], { stdio: ["ignore", "pipe", "pipe"] });
  let shown = false, tail = "";
  // 網址可能被切成兩段送來，所以先累積最後一段輸出再找
  const watch = buf => {
    tail = (tail + String(buf)).slice(-4000);
    const m = tail.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m && !shown) {
      shown = true;
      // 密碼不印在畫面上（螢幕可能正在投影），直接放進剪貼簿；網址單獨用沒用，可以印
      let copied = false;
      try { execFileSync("clip", { input: KEY }); copied = true; } catch (e) { /* 不是 Windows 就不複製 */ }
      console.log("\n==================== 貼進 Apps Script 的「指令碼屬性」 ====================");
      console.log(`  ① SEARCH_RELAY_KEY ＝ ${copied ? "按 Ctrl+V（密碼已經在剪貼簿，畫面上不顯示）" : "用記事本開 " + KEY_FILE + " 複製整行"}`);
      console.log(`  ② SEARCH_RELAY_URL ＝ ${m[0]}`);
      console.log(`  密碼要再複製一次：Get-Content "${KEY_FILE}" | Set-Clipboard`);
      console.log("  網址每次重開都會換：換了只要改指令碼屬性，不用重新部署。");
      console.log("  這個視窗不要關；關掉＝bot 查不到。按 Ctrl+C 結束。");
      console.log("==========================================================================\n");
    }
  };
  cf.stdout.on("data", watch);
  cf.stderr.on("data", watch);
  cf.on("error", err => log(`⚠️ 通道程式開不起來：${err.message}。轉接站還在，可以另開視窗手動跑：cloudflared tunnel --url http://127.0.0.1:${PORT}`));
  cf.on("exit", code => log(shown
    ? `⚠️ 通道結束了（代碼 ${code}）：bot 現在連不到這裡，重開本程式會拿到新網址`
    : `⚠️ 通道還沒拿到網址就結束了（代碼 ${code}）：看網路，或另開視窗手動跑 cloudflared tunnel --url http://127.0.0.1:${PORT}`));
  process.on("exit", () => cf.kill());
  process.on("SIGINT", () => process.exit(0));
}

server.listen(PORT, "127.0.0.1", async () => {  // 只聽本機：外面只能從通道進來
  log(`轉接站開好了：http://127.0.0.1:${PORT}（模型 ${MODEL}）`);
  const ready = await warmUp();
  if (WANT_TUNNEL && !ready) {
    log("⛔ 模型還沒準備好，先不開通道（開了 bot 問也只會收到錯誤）。修好 Ollama 後按 Ctrl+C、再跑一次本程式。");
  } else if (WANT_TUNNEL) startTunnel();
  else {
    console.log(`\n本機測試（另開 PowerShell 貼）：`);
    const keyExpr = process.env.RELAY_KEY ? "$env:RELAY_KEY" : `(Get-Content "${KEY_FILE}")`;
    console.log(`  Invoke-RestMethod -Method Post -Uri http://127.0.0.1:${PORT}/ask -Headers @{"x-relay-key"=${keyExpr}} -ContentType "application/json; charset=utf-8" -Body ([Text.Encoding]::UTF8.GetBytes('{"question":"2026 年諾貝爾物理獎得主是誰？"}'))\n`);
  }
});
