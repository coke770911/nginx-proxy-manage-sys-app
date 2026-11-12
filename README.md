# Nginx HA Proxy Manager

目前版本：**v1.0.10**

校園網域反向代理與 SSL 憑證集中管理系統（控制層）。管理員於網頁維護「網域 → 後端」規則與憑證，按下「一鍵同步部署」後，後端以 SSH/SFTP 平行推送到兩台 Ubuntu（26.04 / 24.04）Nginx，**兩台 `nginx -t` 都通過才 reload，任一失敗自動回滾**。

## 主要功能

```
使用者 ──HTTPS──→ F5 ──→ Nginx 節點 ×2（SSL 卸載）──HTTP──→ 後端伺服器（可多台負載平衡）
                              ↑
              本系統：集中管理規則與憑證，一鍵同步部署
```

### 1. 反向代理與 SSL 卸載

- 每個「來源網域」對應一組後端主機，由兩台 Nginx 節點代理；後端不需安裝憑證，只要提供 HTTP。
- HTTPS 加解密在 Nginx 節點完成（SSL Offloading）：TLS 1.2 / 1.3、HTTP/2、Session Cache，關閉 Session Ticket。
- 可設定強制 HTTPS（HTTP 301 轉址）、WebSocket、上傳大小上限，並帶入 `X-Forwarded-For` / `X-Forwarded-Proto` / `X-Real-IP` 等標頭，後端可得知原始協定與來源。
- 規則可一鍵切換「維護中頁面」（HTTP 503），也可從節點測試後端是否連得上。
- 支援 CSV 批次匯入 / 匯出、網域或 IP 搜尋。

### 2. SSL 憑證集中管理

- 憑證只在本系統上傳一次，部署時自動推送到所有節點，不必逐台登入更換。
- 支援 PEM（憑證 + 私鑰）與 PFX 上傳；自動驗證公私鑰是否相符、排好完整憑證鏈（Fullchain），並解析涵蓋網域（SAN）與到期日。
- 清單顯示剩餘天數，60 / 30 / 14 天內分別以藍 / 橘 / 紅標示；續約時直接更新同一張憑證，所有綁定的網域一起換新。
- 新增規則或 CSV 匯入時可自動挑選涵蓋該網域、到期日最晚的憑證；仍被規則使用的憑證無法刪除。
- 私鑰不寫入操作紀錄，也不會出現在 API 回應中。

### 3. 負載平衡

- 一條規則可設定多台後端，寫入 Nginx `upstream`；每台可設權重、備援（平時不分流）或暫時停用。
- 分配方式：輪流、最少連線、依 Cookie 固定（適用需要 Session 的系統）。
- 後端故障自動排除（連續 3 次失敗暫停 10 秒），請求失敗時自動改送下一台。
- 前端由 F5 分流到兩台 Nginx 節點，形成「F5 → 雙 Nginx → 多台後端」兩層高可用架構。

詳細設定請見下方「負載平衡」「網域規則匯入 / 匯出」等章節。

## 目錄結構

```
├─ CLAUDE.md                    代理規則（版號、README、安全規範）
├─ VERSION                      版號唯一來源（由 npm run release 維護）
├─ scripts/                     version.js 版號規則、release.js 發佈腳本
├─ .githooks/                   pre-commit（檢查 README）、pre-push（檢查版號 tag）
├─ ecosystem.config.js          PM2 設定檔（單一執行個體，Log 輸出到 logs/）
├─ database/schema.sql          SQL Server DDL（7 張資料表，可重複執行並自動轉換舊資料）+ 兩台節點範例資料
├─ backend/                     Node.js + Express + Sequelize(mssql) + JWT
│  ├─ public/                   前端編譯產物（frontend npm run build 自動輸出，不進版控）
│  └─ src/
│     ├─ app.js                 進入點（JWT 驗證、靜態檔、健康檢查排程，單一 port）
│     ├─ config/ db/ models/    設定、連線、7 張資料表 Model
│     ├─ routes/authRoutes.js   登入 API、JWT 驗證中介層、登入失敗鎖定
│     ├─ routes/proxyRoutes.js  REST API + SSE 即時 Log + 操作紀錄查詢
│     ├─ routes/accountRoutes.js 帳號管理 API
│     └─ services/
│        ├─ soapAuth.js         SOAP 帳號密碼驗證
│        ├─ accountService.js   可登入名單（資料庫帳號 + .env 特權帳號）
│        ├─ auditService.js     系統操作紀錄寫入（不含密碼 / 私鑰）
│        ├─ certService.js      憑證解析 / 公私鑰比對 / PFX 轉檔
│        ├─ nginxTemplate.js    .conf 生成器（upstream 負載平衡、欄位白名單驗證、503 維護頁、502 / 504 / 404 柴犬頁）
│        ├─ sshSession.js       SSH+SFTP 連線封裝（可驗證主機金鑰）
│        ├─ deployService.js    雙機兩階段部署與回滾引擎
│        ├─ backendProbe.js     從節點測試後端連線（TCP + HTTP 狀態碼）
│        ├─ nodeLogService.js   讀取節點 Nginx access / error Log（唯讀、白名單）
│        ├─ ruleImport.js       網域規則 CSV 匯入解析、格式檢查、重複比對與匯出
│        └─ healthService.js    節點燈號（SSH + nginx active）與 CPU / RAM / 硬碟使用率
└─ frontend/                    Vue 3 + Vite + Element Plus（views/Login.vue、views/Dashboard.vue）
```

## 快速開始

```bash
# 1. 建資料庫（SSMS 或 sqlcmd 執行）
sqlcmd -S <host> -U sa -i database/schema.sql   # 可重複執行；舊版升級時再跑一次即可補上新資料表

# 2. 設定（Windows：copy backend\.env.example backend\.env）
cp backend/.env.example backend/.env
#    必填：DB_*、JWT_SECRET、ADMIN_ACCOUNTS、SOAP_*、SSH_KEY_PATH

# 3. 安裝、編譯前端、啟動（皆在專案根目錄執行）
npm run install:all                  # 安裝 backend 與 frontend 相依套件
npm run build                        # 前端編譯，輸出到 backend/public
npm start                            # 啟動後端：http://localhost:3000（前端與 API 同一個 port）
```

- 系統**只有後端一個 port**（`PORT`，預設 3000）：前端編譯結果放在 `backend/public`，由 Express 直接提供，不再使用 Vite 開發伺服器。
- 修改前端時可在 `frontend` 執行 `npm run watch`，存檔即自動重新編譯到 `backend/public`，重新整理瀏覽器即可。
- 控制層主機需安裝 openssl（PFX 轉檔用）。

## 正式環境部署（Windows Server 2022 + PM2）

**需要安裝**

| 項目 | 用途 / 說明 |
|---|---|
| Node.js LTS（22 或 24，x64） | 執行後端；最低需求 18.17 |
| PM2：`npm i -g pm2` | 常駐、異常自動重啟、Log |
| pm2-installer 或 NSSM | `pm2 startup` 不支援 Windows，需用這類工具把 PM2 註冊成 Windows 服務，開機自動啟動 |
| OpenSSL | 上傳 PFX 憑證時拆解用，`openssl` 必須在**系統** PATH（Win64 OpenSSL，或 Git for Windows 內附的 `C:\Program Files\Git\usr\bin`） |
| pm2-logrotate（建議）：`pm2 install pm2-logrotate` | 自動切割 Log |

不需要 Visual Studio Build Tools 或 Python（`ssh2` 的 `cpu-features` 為選用原生模組，編譯失敗不影響功能），也不需要 SQL Server 驅動程式（`tedious` 為純 JavaScript）。

**啟動**

```bash
npm run install:all
npm run build
pm2 start ecosystem.config.js
pm2 save          # 記住程序清單，服務重啟後自動還原
```

常用指令：`pm2 status`、`pm2 logs nginx-ha-proxy-manager`、`pm2 restart nginx-ha-proxy-manager`（修改 `.env` 或更新程式後執行）。Log 檔在專案的 `logs/out.log`、`logs/error.log`。

**注意事項**

- **只能跑 1 個執行個體**（`ecosystem.config.js` 已設定 fork 模式，請勿改成 cluster）：部署鎖、登入失敗鎖定、SSE 即時 Log、節點資源數據都存在記憶體。
- **服務帳號權限**：以服務執行時（pm2-installer 預設 Local Service），`openssl` 要在系統 PATH；`SSH_KEY_PATH` 私鑰檔與 `backend\.env` 要讓服務帳號讀得到，並以 NTFS 權限限制只有系統管理員與服務帳號可讀（例如私鑰放 `C:\ProgramData\nginx-ha-manager\keys\`）。
- **HTTPS**：建議以 IIS + URL Rewrite + ARR 套上憑證後轉給 `localhost:9050`（`TRUST_PROXY` 維持 `loopback`）；部署即時 Log 使用 SSE，需在 IIS 關閉回應緩衝（`responseBufferLimit="0"`），否則 Log 會在部署結束才一次出現。不使用 IIS 時，需在 Windows 防火牆開放 `PORT` 輸入連線。
- **對外連線**：需能連到 SQL Server（1433）、兩台 Nginx 節點（SSH 22）與 SOAP 認證服務。
- 連續啟動失敗 10 次（例如 `.env` 設定錯誤、資料庫連不上）PM2 會停止重啟，請用 `pm2 logs` 查看原因。

## 登入與權限（SOAP + JWT）

登入條件需**同時**滿足：

1. 帳號在**可登入名單**內：`backend/.env` 的 `ADMIN_ACCOUNTS`（特權帳號，逗號分隔、不分大小寫）**加上**「帳號管理」分頁中新增且啟用的帳號。
2. 帳號密碼通過 `SOAP_URL` 指定的 SOAP 認證服務驗證（本系統不保存任何密碼）。

登入成功後後端簽發 JWT（HS256，`JWT_SECRET` 簽章，有效時間 `JWT_EXPIRES_IN`），前端存於 `sessionStorage`，之後所有 API 以 `Authorization: Bearer <token>` 驗證；SSE 即時 Log 因 EventSource 無法帶標頭，改以 `?token=` 傳遞。每次請求都會重新比對可登入名單：在「帳號管理」停用或刪除帳號後，該帳號下一次操作即失去權限；從 `ADMIN_ACCOUNTS` 移除則需重啟後端。部署紀錄的「操作者」會記錄登入帳號。

| 設定 | 說明 |
|---|---|
| `ADMIN_ACCOUNTS` | 特權帳號，例：`admin01,netops`；至少填一個，才能第一次登入並到「帳號管理」新增其他人 |
| `JWT_SECRET` | 至少 32 字元，未設定則後端拒絕啟動；更換後所有人需重新登入 |
| `JWT_EXPIRES_IN` | Token 有效時間，例：`30m`、`8h` |
| `LOGIN_MAX_FAILURES` / `LOGIN_LOCK_MINUTES` | 同一 IP + 帳號連續失敗次數上限與鎖定分鐘數 |
| `SOAP_URL` / `SOAP_VERSION` / `SOAP_ACTION` | SOAP 服務端點、版本（1.1 / 1.2）、SOAPAction |
| `SOAP_NAMESPACE` / `SOAP_METHOD` / `SOAP_USER_FIELD` / `SOAP_PASS_FIELD` | 自動組出 `<METHOD xmlns="NAMESPACE"><USER_FIELD>…</USER_FIELD><PASS_FIELD>…</PASS_FIELD></METHOD>` |
| `SOAP_REQUEST_TEMPLATE` | 選填：完整 Envelope 範本（單行），`{{username}}` / `{{password}}` 自動帶入並 XML 跳脫 |
| `SOAP_SUCCESS_REGEX` | 回應內容符合此正規表示式才算成功，例：`<AuthenticateResult>\s*true\s*</AuthenticateResult>` |
| `SOAP_TLS_VERIFY` | SOAP 服務使用自簽憑證時設 `false` |
| `TRUST_PROXY` | 前方有反向代理時調整（預設 `loopback`），避免偽造 X-Forwarded-For 繞過登入鎖定 |

- 不在白名單的帳號不會送往 SOAP 服務，但回應訊息與密碼錯誤相同，避免帳號被列舉。
- SOAP 回應為 SOAP Fault 或 HTTP 狀態非 200 一律視為驗證失敗；服務無法連線時回 502。

## 帳號管理

「帳號管理」分頁維護可登入名單（資料表 `AdminAccounts`）：

- **新增帳號**後該帳號才能登入；帳號需與 SOAP 認證使用的帳號相同，可填姓名 / 單位與備註。
- 可**停用**或**刪除**帳號，立即生效（不需重啟）；不能停用或刪除自己目前登入的帳號。
- `.env` 的 `ADMIN_ACCOUNTS` 帳號一併列出並標示「.env 特權」，介面上唯讀，只能改 `.env` 後重啟。
- 顯示每個帳號的最後登入時間與建立者；新增、修改、刪除都會寫入操作紀錄。

## 操作紀錄

「操作紀錄」分頁（資料表 `AuditLogs`）記錄誰在何時、從哪個 IP 做了什麼：

| 動作 | 記錄內容 |
|---|---|
| 登入 / 登入失敗 | 帳號、來源 IP、失敗原因（密碼錯誤、不在可登入名單、暫時鎖定、認證服務錯誤） |
| 新增 / 刪除 | 網域規則、SSL 憑證、Nginx 節點、帳號當下的內容 |
| 修改 | 只列出有變動的欄位「舊值 → 新值」 |
| 憑證續約 | 新舊憑證的指紋、到期日、涵蓋網域 |
| 部署 | 對應的部署紀錄編號與結果 |

- 可依關鍵字（帳號、對象、IP、內容）、動作、類別、日期區間查詢，並分頁顯示。
- **不記錄**密碼、PFX 密碼、私鑰與憑證內容；超過 300 字的欄位（例如自訂 Nginx 語法）會截斷。
- 紀錄寫入失敗只會記在後端 console，不影響原本的操作。

## 節點資源監控

節點卡片顯示每台節點的 **CPU 使用率與核心數（例：`0.7% · 4 核`）、RAM、硬碟（`/`）使用率**，滑鼠移到該列可看負載、Swap 與硬碟容量：

- 每次健康檢查（`HEALTH_INTERVAL_SEC`，預設 60 秒，或按卡片旁的重新檢測）時，用同一條 SSH 連線讀取 `/proc/stat`、`/proc/meminfo`、`/proc/loadavg` 與 `df`，**不需要 sudo**。
- 使用率低於 70% 綠色、70–90% 黃色、超過 90% 紅色。上傳大檔時 Nginx 會把請求暫存到 `/var/lib/nginx`，請特別注意硬碟剩餘空間。
- 數據只保存在記憶體，後端重啟後要等下一次檢查才會出現；停用的節點不顯示。

## 網域規則搜尋

「網域對照規則」分頁上方的搜尋框可用**來源網域**或**任一台後端的 IP / Port** 即時過濾（例如 `portal`、`10.0.0.21`、`:8080`）。搜尋框獨立一列，位於「新增規則 / 匯入 / 匯出」按鈕下方；同一列的表格右上角顯示目前筆數（「共 N 筆」，搜尋時為「找到 x / y 筆」）。

清單右側有「建立日期」與「最後更動」兩欄（可點標題排序）；只修改後端主機時「最後更動」也會更新。「最後更動」下方會顯示距今「N 天沒變動」（以日曆日計算，當天修改顯示「今天有更動」），超過 180 天以橘色標示，方便找出久未維護的規則。

清單中的來源網域為超連結，點擊會另開視窗開啟該網站（有綁憑證用 https，否則 http；萬用字元網域 `*.xxx` 僅顯示文字）。

## 網域規則匯入 / 匯出（CSV）

「網域對照規則」分頁的 **匯入** / **匯出** 按鈕可批次管理規則。匯出檔可以直接修改後再匯入；匯入對話框也有「下載範本」。

**檔案格式**：CSV（逗號或 Tab 分隔），第一列為標題，UTF-8 或 Excel 另存的 Big5 皆可，單次最多 500 列。

| 欄位 | 說明 |
|---|---|
| 來源網域 | 必填，例 `portal.aeust.edu.tw` |
| 後端主機 | 必填，多台以 `;` 分隔：`10.0.0.21:8080`、權重 `10.0.0.22:8080*3`、備援 `10.0.0.23:8080(備援)`、停用 `(停用)` |
| 分配方式 | 輪流 / 最少連線 / 依Cookie固定（需填 Cookie名稱）；空白＝輪流 |
| SSL憑證 | 憑證別名或編號；空白會自動挑選涵蓋該網域、到期日最晚的憑證 |
| 強制HTTPS、WebSocket、啟用、維護中 | 是 / 否 |
| 上傳上限 | 例 `50M`；空白＝預設 `2M`（新增規則時表單預設也是 `2M`，已存在的規則不受影響） |
| 備註 | 任意文字 |

**匯入流程**：選擇檔案 → 系統逐列檢查格式並與現有規則比對 → 預覽 → 確認後才寫入資料庫。

| 狀態 | 條件 | 預設動作 |
|---|---|---|
| 新增 | 網域不存在 | 新增 |
| 重複 | **網域相同且後端 IP:Port 相同**（與現有規則，或與檔案中前面的列） | 現有規則：覆蓋更新；檔案內重複：略過 |
| 網域已存在 | 網域相同但後端不同 | 略過（可改為覆蓋更新） |
| 錯誤 | 格式不正確 | 必須刪除該列或修正檔案，才能匯入 |

- 預覽表每列都可刪除，刪除後會自動重新檢查。
- 按「確認匯入」時若仍有重複列，會先跳出**重複清單**，可逐列刪除、「刪除全部重複列並繼續」，或保留並繼續；之後再顯示新增 / 覆蓋 / 略過筆數做最後確認。
- 伺服器端會再檢查一次，有任何錯誤就整批不寫入；全部寫入在同一個交易內完成，並記入操作紀錄（來源：CSV 匯入）。
- 覆蓋更新時，檔案中空白的欄位保留原值；「自訂 Nginx 片段」不會由匯入修改。
- 匯入只寫入資料庫，需再按「一鍵同步部署」才會推送到 Nginx 節點。

## 負載平衡（一條規則對多台後端）

每條網域規則可設定多台後端主機（資料表 `RuleUpstreams`），部署時寫入節點 Nginx 的 `upstream` 區塊，由 Nginx 分配流量：

```
使用者 → F5 ─┬→ nginx-node1 ─┬→ 後端 A
             └→ nginx-node2 ─┴→ 後端 B
        F5 分流到兩台 Nginx      Nginx 依規則分流到多台後端
```

| 設定 | 說明 | 產生的 Nginx 語法 |
|---|---|---|
| 權重 1–100 | 數字越大分到越多流量 | `server 10.0.0.21:8080 weight=3;` |
| 備援 | 主要後端都失效時才使用 | `server ... backup;` |
| 啟用 | 關閉 = 暫時下線維護，不寫入設定 | （不產生該行） |
| 分配方式：輪流（預設） | 依權重輪流 | — |
| 分配方式：最少連線 | 優先送給連線數最少的主機 | `least_conn;` |
| 分配方式：依 Cookie 固定 | 同一個 Cookie 值固定送同一台（例：`JSESSIONID`） | `hash $cookie_JSESSIONID consistent;` |

- **故障切換**：每台 `max_fails=3 fail_timeout=10s`（10 秒內失敗 3 次即暫停 10 秒）；多台後端時，連線失敗、逾時或回 502/503/504 會自動改送下一台（最多 3 次，連線逾時縮短為 5 秒）。Nginx 預設不重送 POST 等非冪等請求，避免重複寫入。
- **限制**：
  - 不提供「依來源 IP 固定」（`ip_hash`）：F5 若做 SNAT，所有請求來源都是 F5，會全部送到同一台。
  - 「依 Cookie 固定」不能搭配備援機（nginx hash 不支援 `backup`）；第一次連線還沒有 Cookie 時會依雜湊分到某一台。
  - 故障偵測為被動式（免費版 Nginx 沒有主動健康檢查），要等真實請求失敗才會暫停該台。
- **與舊版相容**：`schema.sql` 會自動把既有規則的「後端 IP / Port」轉成只有一台後端的清單，產生的設定效果相同；`TargetIp` / `TargetPort` 保留為第一台主要後端。
- 每條規則的 upstream 名稱為 `rule<規則編號>_backend`，並啟用 `keepalive 16` 重用與後端的連線。
- 後端清單的變動會以「舊清單 → 新清單」寫入操作紀錄。

## 從節點測試後端連線

Nginx 部署時只檢查設定語法（`nginx -t`），**不會**檢查後端是否連得上；後端沒開或被防火牆擋住時，部署照樣成功，但使用者會等約 10 秒後得到 504。為了及早發現：

- **規則列表**每列的「從節點測試後端連線」按鈕，以及**規則編輯畫面**的「從節點測試連線」按鈕（可測試尚未儲存的後端），會 SSH 到每台啟用中的節點，平行測試每個啟用中的後端：

  | 結果 | 意義 |
  |---|---|
  | 可連線（附毫秒與 HTTP 狀態碼） | TCP 連得上；HTTP 碼僅供參考（後端只提供 HTTPS 時可能顯示 400） |
  | 逾時 | 5 秒內沒有回應：多半是防火牆沒有對節點開放該 Port，或主機沒開機 |
  | 拒絕連線 | 主機在線但該 Port 沒有服務在監聽，或主機名稱無法解析 |

- **部署時自動檢查**：連線節點後會測試所有啟用規則的後端（維護中的規則略過），連不上的會在即時 Log 以警告列出受影響的網域，但**不阻擋部署**（後端可能刻意尚未上線）。
- 在節點上以 `bash /dev/tcp` 與 `curl` 測試，不需要 sudo；後端的 IP / Port 先經白名單驗證才組成指令，避免指令注入。

### 後端連線燈號（規則清單「後端目標」）

規則清單每個後端 IP 前面有一顆燈號，滑鼠移上去可看各節點的結果（毫秒）與檢測時間：

| 燈號 | 意義 |
|---|---|
| 綠 | 所有啟用中的節點都連得上 |
| 黃 | 只有部分節點連得上（多半是後端防火牆只開放給其中一台節點） |
| 紅 | 所有節點都連不上 |
| 灰 | 尚未檢測（伺服器剛啟動，或剛新增的後端） |
| 淡灰 | 此後端已停用，不檢測 |

- **隨節點健康檢查一起做**：每 `HEALTH_INTERVAL_SEC`（預設 60）秒，在原本的 SSH 連線中順便測試所有啟用規則中的啟用後端，不額外開連線；按節點區的「重新檢測」也會立即更新。
- **只測 TCP**：平行測試、每台最多等 3 秒，不送 HTTP 請求，後端不會因此多出存取紀錄；燈號只代表 Port 有在監聽，網站內容是否正常（例如回 500）仍請用「從節點測試後端連線」按鈕。
- 結果只存在伺服器記憶體，頁面每 30 秒讀一次，不會即時去測；部署進行中暫停檢測，伺服器重啟後於下一輪檢測時恢復。

## 維護中頁面

規則開啟「維護中頁面」後，該網域所有請求會回 **HTTP 503** 與一張內嵌的維護頁面（附 `Retry-After: 3600`，告知搜尋引擎稍後再來）：

- 原創 SVG 插圖「戴安全帽的土撥鼠挖地板」，含 CSS 動畫（使用者系統設定「減少動態」時自動停止），並支援深色模式與手機版面。
- 整頁 HTML 約 5.5 KB 直接寫在 Nginx 設定中，不需要額外的圖檔或外部資源。Nginx 單一參數上限 4096 bytes，因此頁面會切成每段最多 3000 bytes 的變數（`set $page_part0 ...`），再以 `return 503 "$page_part0$page_part1"` 組合回傳；502 / 504 / 404 頁面同樣處理。
- 因為放在 Nginx 單引號字串裡，產生設定時會再檢查一次，確保不含單引號、`$`、反斜線或換行。
- `/f5-health-check` 在維護中仍回 200，F5 不會把節點判定為故障。

## 後端連不上頁面（502 / 504）

後端沒開、Port 沒在監聽、防火牆擋住或回應逾時時，Nginx 不再顯示預設的白底錯誤頁，改回一張內嵌的柴犬頁面（放大鏡當作「502」「504」中間的 0），並顯示網域：

- **502 Bad Gateway**：連不上後端（拒絕連線、主機不通）。**504 Gateway Timeout**：後端逾時沒有回應。狀態碼維持不變，F5 與監控工具仍能正確判斷。
- 只攔 Nginx 自己產生的錯誤；後端程式自己回的 404 / 500 等頁面照常顯示（未開啟 `proxy_intercept_errors`）。
- 多台後端時，會先依負載平衡自動改送其他台，全部失敗才出現此頁。
- 維護中的規則不轉發後端，仍顯示 503 維護頁面。

## 預設站台（404 頁面）

直接以節點 IP（例如 `https://<節點IP>/`）或沒有設定規則的網域連線時，以前會落到第一個網域規則，被轉給不相干的後端（例如出現 IIS 的「HTTP Error 404」）。現在每次部署都會一併產生 `sites-managed/_default_server.conf`：

- `listen 80 default_server` 與 `listen 443 ssl default_server`，回 **HTTP 404** 與一張內嵌頁面：原創 SVG「柴犬拿著放大鏡」，放大鏡就是「404」中間的 0，支援深色模式與手機版面。
- 443 借用目前已部署、到期日最晚的憑證；以 IP 連線本來就會出現「憑證名稱不符」警告，略過後即可看到頁面。沒有任何啟用規則時只產生 80。
- `/f5-health-check` 在預設站台同樣回 200，F5 以 IP 探測不受影響。
- 檔名以底線開頭，不可能和網域規則的設定檔同名；節點上若另有 `default_server`（例如未刪除的 `sites-enabled/default`），`nginx -t` 會失敗並自動回滾。

## 真實客戶端 IP（PROXY protocol，前方有 F5 時）

F5 做 SNAT 時，Nginx 看到的來源都是 F5 的位址，轉給後端的 `X-Real-IP` / `X-Forwarded-For` 和 access log 也都會是 F5。設定 `backend/.env` 的 `PROXY_PROTOCOL_FROM` 後重新部署即可還原：

| 設定 | 說明 |
|---|---|
| `PROXY_PROTOCOL_FROM` | F5 送出連線的來源 IP（Self IP / SNAT 位址），空白或逗號分隔，可用 CIDR；**留空 = 停用**，產生的設定與先前完全相同 |
| `PROXY_PROTOCOL_HTTP_PORT` / `PROXY_PROTOCOL_HTTPS_PORT` | 帶 PROXY protocol 的監聽埠，預設 `8080` / `8443`，不可為 80 / 443 |

啟用後每個網域與預設站台的 server 會多出：

```nginx
listen 8080 proxy_protocol;          # 80 那個 server
listen 8443 ssl proxy_protocol;      # 443 那個 server（SSL 仍在 Nginx 卸載）
set_real_ip_from <PROXY_PROTOCOL_FROM>;
real_ip_header proxy_protocol;
port_in_redirect off;                # 轉址不帶出 8080 / 8443
```

- 原本的 80 / 443 不變：直接連節點、F5 的 `/f5-health-check` 監控照舊。只有從 `PROXY_PROTOCOL_FROM` 送來的 PROXY 標頭才會被採信。
- **節點防火牆**：8080 / 8443 只開給 F5，每台節點執行 `sudo ufw allow from <F5 IP> to any port 8080,8443 proto tcp`；新節點可在初始化腳本填 `__PROXY_PROTOCOL_FROM__` 自動加入。
- **F5 端**（另外設定）：pool 成員改指 `節點:8080` / `節點:8443`，virtual server 加上送出 PROXY v1 標頭的 iRule；健康檢查仍可打 80。
- **順序**：先部署（節點開始監聽 8080 / 8443）並開防火牆，再改 F5 pool；回退時反過來，F5 pool 改回 80 / 443 後再清空 `PROXY_PROTOCOL_FROM`。
- **後端系統**仍需設定「信任節點 IP、改讀 `X-Real-IP`」，例如 Apache `mod_remoteip`、Tomcat `RemoteIpValve`、IIS 記錄欄位加 `X-Real-IP`，才會在自己的 log / 程式中看到真實 IP。

## Ubuntu 節點事前準備（兩台皆需）

```bash
sudo mkdir -p /etc/nginx/sites-managed /etc/nginx/ssl
sudo chown deployer:deployer /etc/nginx/sites-managed /etc/nginx/ssl
sudo chmod 750 /etc/nginx/ssl
# /etc/nginx/nginx.conf 的 http { } 內加入：
#     include /etc/nginx/sites-managed/*.conf;
# 若 sites-enabled/default 佔用 80，請移除以免 default_server 衝突
```

`deployer` 需能寫入上述兩個目錄（本系統不使用 sudo 寫檔），sudoers 僅需 `nginx -t` 與 `systemctl reload nginx`。主機金鑰指紋可填入 `ProxyNodes.HostKeySha256`（`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` 的 `SHA256:...`）以防中間人。

### 節點初始化與安全加固腳本

完整步驟見 [`docs/節點建置操作手冊.md`](docs/節點建置操作手冊.md)；腳本 `.claude/skills/deploy-nginx-node/node-setup.sh` 一次完成上述初始化與以下加固，可重複執行（既有節點重跑即可補上加固）：

- **防火牆**：ufw 的 SSH（22）只開放 `SSH_ALLOW_NETS` 指定網段，**必須包含本管理主機所在網段**，否則無法部署。
- **SSH**：禁止 root 登入、關閉 X11、`MaxAuthTries 3`、`AllowUsers sysadmin deployer`；sysadmin 已設定金鑰時才關閉密碼登入。
- **fail2ban**：防 SSH 暴力破解，允許網段列入白名單。
- **其他**：`server_tokens off`（回應標頭不顯示 Nginx 版本）、自動安全更新、sysctl 網路參數、停用不需要的服務。

### 節點日常維運（Claude 技能）

- `.claude/skills/deploy-nginx-node/`：建置新節點並接入系統（安裝 OS、初始化與加固腳本、登錄節點、健康檢查）。
- `.claude/skills/nginx-node-ops/`：既有節點維運，包含：
  - 健康檢查。
  - 唯讀安全稽核：`node-audit.sh` 以 deployer 身分執行，不需 root，附預期值對照表。
  - 重新加固。
  - Ubuntu 更新與輪流重開機。
  - SSH 允許網段與 fail2ban 管理。
  - Nginx Log 權限。
  - 節點連不上或時好時壞的排查：以 `arping -0` 確認 IP 衝突，並在 vCenter 以 MAC 欄位篩選找出衝突的 VM，只查詢、不修改 VM。

手動執行稽核：

```bash
tr -d '\r' < .claude/skills/nginx-node-ops/node-audit.sh | ssh -i <私鑰> -o BatchMode=yes deployer@<節點IP> 'bash -s'
```

### Ubuntu 26.04 注意事項

- **HTTP/2 寫法**：26.04 的 nginx ≥ 1.25.1，`.env` 的 `NGINX_HTTP2_SYNTAX` 保持預設 `modern` 即可；若仍有 24.04 節點請改 `legacy`（兩台需同版本）。
- **sudo-rs**：25.10 起預設 sudo 為 Rust 版 sudo-rs，設定好 sudoers 後請以 deployer 手動確認 `sudo -n /usr/sbin/nginx -t` 與 `sudo -n /usr/bin/systemctl reload nginx` 都不需密碼。
- **Rust 版 coreutils**：部署與回滾使用 `tar`、`find -delete`，上線前請在測試機故意做一次失敗部署（例如自訂語法寫錯），確認回滾能完整還原。
- **OpenSSH 10.x**：預設優先抗量子金鑰交換，本系統的 ssh2 會自動退回 curve25519，可正常連線；若 SSH 加固為「只允許抗量子金鑰交換」將無法連線。部署金鑰請使用 ed25519。
- **OpenSSL 3.5**：RSA 1024 或 SHA-1 簽章等弱憑證會讓 `nginx -t` 失敗（系統會自動回滾）。

## 節點管理

`schema.sql` 只建立兩筆範例節點（`192.168.10.11/12`），請登入後到「Nginx 節點」分頁（或點節點卡片上的編輯鈕）改成實際主機：

| 欄位 | 說明 |
|---|---|
| 節點名稱 / IP / SSH Port / SSH 帳號 | IP 可填 IPv4 或主機名稱；帳號預設 `deployer` |
| 私鑰路徑 | 控制層主機上的私鑰檔；留空則使用 `.env` 的 `SSH_KEY_PATH` |
| 主機金鑰指紋 | `SHA256:...`；按「從主機讀取」會連到該主機取得指紋（只做金鑰交換、不登入），讀取後請與主機上 `ssh-keygen -lf` 的結果核對。留空則不驗證 |
| 啟用 | 部署只會推送到啟用中的節點 |

可新增、編輯、刪除節點；刪除節點不會清除該主機上已部署的設定。儲存後按節點列右側的「重新檢測」確認燈號。

## 檢視節點 Nginx Log

節點卡片或「Nginx 節點」分頁的文件圖示按鈕可開啟 **Nginx Log** 視窗，透過 SSH 即時讀取該節點的 Log（唯讀）：

- **存取紀錄** `access.log` / **錯誤紀錄** `error.log`，可選最後 100 / 200 / 500 / 1000 / 2000 行。
- **關鍵字搜尋**：從最後 50,000 行中找含關鍵字的行（不分大小寫、固定字串比對，例如 IP、網址、` 502 `）。
- 可勾選每 5 秒自動更新、最新的在最上面；access.log 的 4xx 以黃色、5xx 以紅色標示，error.log 依等級（warn / error）標示。
- 只能讀白名單中的兩個檔案（目錄由 `.env` 的 `REMOTE_LOG_DIR` 設定，預設 `/var/log/nginx`）；關鍵字以單引號包起來交給 `grep -F`，並禁止控制字元，避免指令注入。單次最多回傳 2 MB。

**節點權限（每台執行一次）**：Ubuntu 的 Nginx Log 屬於 `www-data:adm`、權限 640，`deployer` 預設讀不到（視窗會顯示以下指令）。不建議把 `deployer` 加入 `adm` 群組（可讀 `auth.log` 等所有系統 Log），改用 ACL 只開放 `/var/log/nginx`，並設預設 ACL 讓 logrotate 新建的檔案自動繼承。以 sysadmin 登入節點執行：

```bash
sudo apt-get install -y acl          # Ubuntu Server 預設沒有 setfacl
sudo setfacl -m u:deployer:rx /var/log/nginx
sudo setfacl -d -m u:deployer:r /var/log/nginx
sudo setfacl -m u:deployer:r /var/log/nginx/*.log
```

新建節點時，`.claude/skills/deploy-nginx-node/node-setup.sh` 已包含這一步。

### Log 保留期限（一年）

Ubuntu 預設只保留 14 天。節點改為由 logrotate **保留一年**：每天切一份新檔、隔天壓縮（gzip，約剩一成），檔名附日期（例 `access.log-20261112.gz`），超過 365 天自動刪除（`rotate 365` + `maxage 365`）。新檔案會繼承上面的 ACL，管理介面仍可讀取。

- 管理介面的「檢視 Log」只讀目前的 `access.log` / `error.log`（當天）；較舊的紀錄需登入節點以 `zcat` / `zgrep` 查詢。
- 以目前流量估算一年僅數 MB；即使流量放大百倍也只約數 GB，節點硬碟（144 GB）足夠。
- 新建節點時，`node-setup.sh` 的步驟 7c 會寫入此設定；既有節點以 sysadmin 執行一次：

```bash
sudo sed -i -e 's/^\(\s*\)rotate 14$/\1rotate 365\n\1maxage 365\n\1dateext\n\1dateformat -%Y%m%d/' /etc/logrotate.d/nginx
sudo logrotate -d /etc/logrotate.d/nginx 2>&1 | grep -iE "error|rotating pattern"
```

## 部署流程對照

| 階段 | 動作 | 失敗時 |
|---|---|---|
| 0 | 平行連線所有啟用節點 | 中止，未變更任何節點 |
| 1 | 備份 `sites-managed` + `ssl` → `/tmp/nginx_backup.tar.gz`，寫入憑證與 `.conf`（先寫 `.tmp` 再 rename） | 自動回滾 |
| 2 | 平行 `sudo nginx -t` | 全部節點回滾，`stderr` 原文寫入 `DeployLogs.ErrorDetail` 並回傳前端 |
| 3 | 平行 `sudo systemctl reload nginx`，更新 `LastSyncAt` | 狀態標為 `PARTIAL` |

部署為「完整鏡像」：停用/刪除的規則與孤兒憑證會一併從遠端清除。同一時間只允許一個部署（再觸發回 409）。

## 注意事項

- **私鑰存放**：`KeyPem` 以明文存於 SQL Server，請限制 DB 存取，並建議啟用 TDE / 欄位加密；備份檔 `/tmp/nginx_backup.tar.gz` 含私鑰，權限為 600。
- **真實客戶端 IP**：F5 為 L4 Passthrough，有 SNAT 時 Nginx 看到的 `$remote_addr` 為 F5 位址；設定 `PROXY_PROTOCOL_FROM` 即可改用 PROXY protocol 還原，詳見上方「真實客戶端 IP（PROXY protocol）」。
- **`/f5-health-check`** 設於每個網域與預設站台的 80/443 server；F5 以 IP 探測時會落到預設站台，仍會回 200。
- **認證**：SOAP 帳密驗證 + 可登入名單（帳號管理 + `ADMIN_ACCOUNTS`）+ JWT，詳見上方「登入與權限」；正式環境請以 HTTPS 提供本系統，避免帳密與 Token 以明文傳輸。
- 版本相容：HTTP/2 寫法由 `.env` 的 `NGINX_HTTP2_SYNTAX` 決定。`modern`（預設）產生 `listen 443 ssl;` + `http2 on;`，適用 nginx ≥ 1.25.1（Ubuntu 26.04）；`legacy` 產生 `listen 443 ssl http2;`，適用 nginx 1.24（Ubuntu 24.04），在新版 nginx 上會出現過時警告。兩台節點請使用相同 Ubuntu 版本。
- 自訂 Nginx 語法插入 443 server 區塊（位於 `location /` 之前），僅檢查大括號成對，語法正確性由 `nginx -t` 把關。
- 介面上的時間一律以當地時間 `YYYY/MM/DD HH:mm:ss` 顯示；部署紀錄 Log 以伺服器當地時間寫入，舊紀錄中的 UTC 時間會在顯示時自動轉換。
- 手機版（寬度 768px 以下）節點卡片滿版顯示，「重新檢測 / 新增節點」按鈕移到卡片上方，不會擠壓卡片。
- 憑證上傳對話框每次開啟都會重置檔案欄位（`destroy-on-close`），選取的 PEM / PFX 檔會正確帶入表單。

## 版號規則與發佈流程

版號格式 `x.y.z`：每次發佈 z + 1；z 超過 20 時 y + 1、z 歸 0；y 超過 20 時 x + 1、y 歸 0（例：`1.0.20 → 1.1.0`、`1.20.20 → 2.0.0`）。完整規則見 `CLAUDE.md`。

```bash
npm run setup-hooks              # clone 後執行一次，啟用 .githooks
git commit -m "..."              # 每次 commit 必須包含 README.md 的修改
npm run release                  # 升版 → 更新 README 版號與更新紀錄 → commit → tag → push
npm run release -- --no-push     # 只升版與 tag，不推送
npm run version:test             # 驗證版號進位規則
```

第一次推送到 GitHub：先在 GitHub 建立空的 repository，再執行 `git remote add origin <網址>` 與 `npm run release`。

## 更新紀錄

### v1.0.10（2026-11-12）

- 新增：規則建立日期 / 最後更動欄位、後端連線燈號、CPU 核心數

### v1.0.9（2026-11-12）

- 新增：節點安全加固（初始化腳本、技能說明與操作手冊）

### v1.0.8（2026-11-12）

- 更新：README 主要功能說明與介面調整

### v1.0.7（2026-11-11）

- 新增：網域規則 CSV 匯入 / 匯出

### v1.0.6（2026-11-11）

- 新增：從節點測試後端連線、土撥鼠維護中頁面

### v1.0.5（2026-11-11）

- 新增：PM2 設定檔 ecosystem.config.js 與 Windows Server 2022 部署說明

### v1.0.4（2026-11-11）

- 新增：負載平衡（一條網域規則對多台後端）

### v1.0.3（2026-11-11）

- 新增：帳號管理、系統操作紀錄、節點資源監控、網域規則搜尋

### v1.0.2（2026-11-11）

- 新增：NGINX_HTTP2_SYNTAX 設定（支援 Ubuntu 26.04），修正憑證上傳檔案未帶入表單

### v1.0.1（2026-11-11）

- 新增：SOAP 登入 + 特權帳號白名單 + JWT 驗證、單一 port 部署、節點管理介面

### v1.0.0

- 初始版本：SQL Server 資料表結構、Express 後端、憑證解析與 PFX 轉檔、雙機兩階段部署與回滾引擎、Vue 3 管理介面
- 新增代理規則（CLAUDE.md）、版號自動進位與發佈腳本、git hooks
