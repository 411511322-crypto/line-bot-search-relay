# LINE AI 待辦小秘書 ＋ 本地搜尋轉接站 (W7 進階版)

本專案結合 **雲端 Google Apps Script (GAS)** 與 **本地 Ollama AI 模型 (Gemma 4)**，實現「雲端接收不中斷、特殊查詢轉本地聯網搜尋」的混合架構。

---

## 🏗️ 系統架構

```
[ 手機 LINE ]
      │
      ▼ (Webhook)
[ Google Apps Script (/exec) ] ── (一般待辦、照片) ──> [ Google Sheets / Calendar / Gemini ]
      │
      ▼ (只有「查 …」「搜尋 …」)
[ Cloudflare Tunnel (https://....trycloudflare.com) ]
      │
      ▼ (POST /ask + 密碼驗證)
[ 本地轉接站 line-search-relay.mjs (127.0.0.1:8787) ]
      │
      ▼
[ 本地模型 Ollama (gemma4:e4b) ] ── (web_search / web_fetch) ──> [ 網際網路即時搜尋 ]
```

* **雲端永不停機**：LINE Webhook 始終綁定 Google Apps Script 的 `/exec` 網址，即使個人電腦關機，日常待辦事項、照片解析依然正常運作。
* **按需轉發本地**：僅當使用者輸入「`查 `」或「`搜尋 `」開頭的訊息時，透過 Cloudflare 穿透通道打回本機轉接站，使用 Ollama 進行實時聯網搜尋並附上參考來源。
* **安全隔離**：API 金鑰與轉接站通關密碼均存放於 Apps Script「指令碼屬性」，不入程式碼、不入 Git。

---

## 📦 怎麼裝（環境準備）

### 1. 安裝本地環境
1. **Ollama**：
   * 安裝 Ollama 並下載 `gemma4:e4b` 模型：
     ```powershell
     winget install --id Ollama.Ollama -e --silent
     ollama pull gemma4:e4b
     ```
2. **Node.js**（需 v18 以上，執行轉接站）：
   ```powershell
   winget install --id OpenJS.NodeJS.LTS -e --silent
   ```
3. **Cloudflare Tunnel（cloudflared）**：
   * 下載免安裝單一執行檔至工作目錄（例如 `%USERPROFILE%\line-relay`）：
     ```powershell
     New-Item -ItemType Directory -Force "$env:USERPROFILE\line-relay"
     Invoke-WebRequest -Uri https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe -OutFile "$env:USERPROFILE\line-relay\cloudflared.exe"
     $env:PATH += ";$env:USERPROFILE\line-relay"
     ```

---

## 🚀 怎麼跑（啟動與設定）

### 步驟 1：啟動本機轉接站
切換到專案目錄或放置 `line-search-relay.mjs` 與 `cloudflared.exe` 的目錄：
```powershell
$env:PATH += ";$env:USERPROFILE\line-relay"
node line-search-relay.mjs
```
啟動成功後，終端機將載入模型並開啟通道，顯示如下資訊：
* `SEARCH_RELAY_URL`：例如 `https://xxxx.trycloudflare.com`（通道網址）
* `SEARCH_RELAY_KEY`：轉接站自動產生並已複製到剪貼簿的通關密碼（存於 `~/.line-search-relay.key`）

### 步驟 2：部署 Google Apps Script
1. 開啟 Google 試算表 $\to$「擴充功能」$\to$「Apps Script」。
2. 將本專案的 `Code.gs` 與 `appsscript.json` 複製覆蓋至編輯器。
3. 進入「專案設定」$\to$「指令碼屬性」，新增以下設定值：
   * `GEMINI_API_KEY`：Google AI Studio API 金鑰
   * `LINE_CHANNEL_ACCESS_TOKEN`：LINE Developers Messaging API 長效存取憑證
   * `SEARCH_RELAY_URL`：轉接站印出的通道網址（以 `https://` 開頭，結尾無斜線）
   * `SEARCH_RELAY_KEY`：轉接站生成的通關密碼
4. 於編輯器執行 `testSetup` 函式，確認各項權限與本地轉接站檢驗通過（均顯示 ✅）。
5. 點擊右上角「部署」$\to$「管理部署作業」$\to$ 編輯版本為「**新版本**」並部署。

### 步驟 3：測試功能
* **測試查詢（轉本地）**：在手機 LINE 傳送：
  ```
  查 2026 年諾貝爾物理獎得主是誰？
  ```
  * 手機收到完整回答、來源網址列表與查詢秒數。
  * 電腦終端機視窗同步印出：`📩 收到一題`、`🔍 模型決定搜`、`✅ 回答好了`。
* **測試一般待辦（走雲端）**：傳送「`明天下午兩點開會`」，驗證試算表正常寫入新列、回覆「✅ 記好了」，確認既有功能不受影響。

---

## 📝 你改了什麼（相較於 W5/W6）

### 1. 架構改動
* **W5 版本**：整套都在雲端 Apps Script，無聯網搜尋能力（Gemini 免費版無法動態搜尋最新事實）。
* **W6 簡單版**：整支 Bot 都在本機 Python 跑，電腦關閉則 Bot 完全失效。
* **W7 進階版（本專案）**：
  * 保留 W5 的雲端 Webhook 接收端（穩定性高）。
  * 引入「分流」機制：只有特定前綴導向本地模型搜尋。

### 2. `Code.gs` 具體改動
1. **設定區新增常數**：
   * 增加 `SEARCH_RELAY_URL`、`SEARCH_RELAY_KEY`（由 `PropertiesService` 讀取，不寫死於程式）。
   * 定義 `SEARCH_PREFIX = /^(?:查|搜尋)[\s:：]+([\s\S]+)$/`，僅命中「查」「搜尋」接空格或冒號時觸發，避免誤攔截「查一下明天行程」等待辦事項。
2. **`handleEvent` 增加分流判斷**：
   * 文字訊息先比對 `SEARCH_PREFIX`。
   * 若符合查詢條件，開啟 `showLoading(event.source, 60)` 輸入中動畫，呼叫 `askLocalSearch` 函式並將結果回覆給 LINE。
3. **新增 `askLocalSearch` 轉發函式**：
   * 使用 `UrlFetchApp.fetch` 發送 `POST /ask` 至通道網址，標頭帶入 `x-relay-key`。
   * 設定 `timeoutSeconds: 50`，避免 LINE 回覆憑證逾時。
   * **連線失敗防護**：若本機關機或通道斷線，明確提示「本地模型現在連不到」，**堅持不 fallback 至 Gemini 猜測答案**，保持資料真實性與附來源原則。
   * 解析轉接站回傳的 `answer` 與 `sources` 陣列，排版成易讀訊息與來源清單回傳。
4. **`testSetup` 整合健康檢查**：
   * 新增轉接站 `GET /check-key` 測試項目，快速檢查網址與金鑰是否正確，節省人工排查時間。

---

## 🔒 安全聲明
* 程式中絕不包含任何硬編碼的密碼、金鑰、或個人機敏資料。
* 通關密碼僅透過本機安全生成（`crypto.randomBytes`）並本地驗證。
