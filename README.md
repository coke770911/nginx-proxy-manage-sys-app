# Nginx HA Proxy Manager

目前版本：**v1.0.5**

校園網域反向代理與 SSL 憑證集中管理系統（控制層）。管理員於網頁維護「網域 → 後端」規則與憑證，按下「一鍵同步部署」後，後端以 SSH/SFTP 平行推送到兩台 Ubuntu（26.04 / 24.04）Nginx，**兩台 `nginx -t` 都通過才 reload，任一失敗自動回滾**。

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
│        ├─ nginxTemplate.js    .conf 生成器（upstream 負載平衡、欄位白名單驗證）
│        ├─ sshSession.js       SSH+SFTP 連線封裝（可驗證主機金鑰）
│        ├─ deployService.js    雙機兩階段部署與回滾引擎
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

節點卡片顯示每台節點的 **CPU、RAM、硬碟（`/`）使用率**，滑鼠移到該列可看核心數、負載、Swap 與硬碟容量：

- 每次健康檢查（`HEALTH_INTERVAL_SEC`，預設 60 秒，或按卡片旁的重新檢測）時，用同一條 SSH 連線讀取 `/proc/stat`、`/proc/meminfo`、`/proc/loadavg` 與 `df`，**不需要 sudo**。
- 使用率低於 70% 綠色、70–90% 黃色、超過 90% 紅色。上傳大檔時 Nginx 會把請求暫存到 `/var/lib/nginx`，請特別注意硬碟剩餘空間。
- 數據只保存在記憶體，後端重啟後要等下一次檢查才會出現；停用的節點不顯示。

## 網域規則搜尋

「網域對照規則」分頁上方的搜尋框可用**來源網域**或**任一台後端的 IP / Port** 即時過濾（例如 `portal`、`10.0.0.21`、`:8080`），並顯示符合筆數。

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
- **真實客戶端 IP**：F5 為 L4 Passthrough，Nginx 看到的 `$remote_addr` 為 F5 位址（若有 SNAT）。要取得真實 IP 需 F5 不做 SNAT，或改用 PROXY protocol（Nginx 加 `listen ... proxy_protocol` 與 `real_ip` 設定）。
- **`/f5-health-check`** 設於每個網域的 80/443 server；F5 以 IP 探測時會落到第一個 server block，仍會回 200。
- **認證**：SOAP 帳密驗證 + 可登入名單（帳號管理 + `ADMIN_ACCOUNTS`）+ JWT，詳見上方「登入與權限」；正式環境請以 HTTPS 提供本系統，避免帳密與 Token 以明文傳輸。
- 版本相容：HTTP/2 寫法由 `.env` 的 `NGINX_HTTP2_SYNTAX` 決定。`modern`（預設）產生 `listen 443 ssl;` + `http2 on;`，適用 nginx ≥ 1.25.1（Ubuntu 26.04）；`legacy` 產生 `listen 443 ssl http2;`，適用 nginx 1.24（Ubuntu 24.04），在新版 nginx 上會出現過時警告。兩台節點請使用相同 Ubuntu 版本。
- 自訂 Nginx 語法插入 443 server 區塊（位於 `location /` 之前），僅檢查大括號成對，語法正確性由 `nginx -t` 把關。
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
