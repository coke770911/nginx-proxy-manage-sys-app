# Nginx HA Proxy Manager

目前版本：**v1.0.2**

校園網域反向代理與 SSL 憑證集中管理系統（控制層）。管理員於網頁維護「網域 → 後端」規則與憑證，按下「一鍵同步部署」後，後端以 SSH/SFTP 平行推送到兩台 Ubuntu（26.04 / 24.04）Nginx，**兩台 `nginx -t` 都通過才 reload，任一失敗自動回滾**。

```
├─ CLAUDE.md                    代理規則（版號、README、安全規範）
├─ VERSION                      版號唯一來源（由 npm run release 維護）
├─ scripts/                     version.js 版號規則、release.js 發佈腳本
├─ .githooks/                   pre-commit（檢查 README）、pre-push（檢查版號 tag）
├─ database/schema.sql          SQL Server DDL + 兩台節點範例資料
├─ backend/                     Node.js + Express + Sequelize(mssql) + JWT
│  ├─ public/                   前端編譯產物（frontend npm run build 自動輸出，不進版控）
│  └─ src/
│     ├─ app.js                 進入點（JWT 驗證、靜態檔、健康檢查排程，單一 port）
│     ├─ config/ db/ models/    設定、連線、4 張資料表 Model
│     ├─ routes/authRoutes.js   登入 API、JWT 驗證中介層、登入失敗鎖定
│     ├─ routes/proxyRoutes.js  REST API + SSE 即時 Log
│     └─ services/
│        ├─ soapAuth.js         SOAP 帳號密碼驗證
│        ├─ certService.js      憑證解析 / 公私鑰比對 / PFX 轉檔
│        ├─ nginxTemplate.js    .conf 生成器（含欄位白名單驗證）
│        ├─ sshSession.js       SSH+SFTP 連線封裝（可驗證主機金鑰）
│        ├─ deployService.js    雙機兩階段部署與回滾引擎
│        └─ healthService.js    節點燈號（SSH + nginx active）
└─ frontend/                    Vue 3 + Vite + Element Plus（views/Login.vue、views/Dashboard.vue）
```

## 快速開始

```bash
# 1. 建資料庫（SSMS 或 sqlcmd 執行）
sqlcmd -S <host> -U sa -i database/schema.sql

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

## 登入與權限（SOAP + JWT）

登入條件需**同時**滿足：

1. 帳號列在 `backend/.env` 的 `ADMIN_ACCOUNTS`（特權帳號白名單，逗號分隔、不分大小寫）。
2. 帳號密碼通過 `SOAP_URL` 指定的 SOAP 認證服務驗證。

登入成功後後端簽發 JWT（HS256，`JWT_SECRET` 簽章，有效時間 `JWT_EXPIRES_IN`），前端存於 `sessionStorage`，之後所有 API 以 `Authorization: Bearer <token>` 驗證；SSE 即時 Log 因 EventSource 無法帶標頭，改以 `?token=` 傳遞。每次請求都會重新比對白名單，帳號從 `ADMIN_ACCOUNTS` 移除並重啟後端後，已簽發的 Token 立即失效。部署紀錄的「操作者」會記錄登入帳號。

| 設定 | 說明 |
|---|---|
| `ADMIN_ACCOUNTS` | 特權帳號白名單，例：`admin01,netops` |
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
- **認證**：SOAP 帳密驗證 + `ADMIN_ACCOUNTS` 白名單 + JWT，詳見上方「登入與權限」；正式環境請以 HTTPS 提供本系統，避免帳密與 Token 以明文傳輸。
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

### v1.0.2（2026-11-11）

- 新增：NGINX_HTTP2_SYNTAX 設定（支援 Ubuntu 26.04），修正憑證上傳檔案未帶入表單

### v1.0.1（2026-11-11）

- 新增：SOAP 登入 + 特權帳號白名單 + JWT 驗證、單一 port 部署、節點管理介面

### v1.0.0

- 初始版本：SQL Server 資料表結構、Express 後端、憑證解析與 PFX 轉檔、雙機兩階段部署與回滾引擎、Vue 3 管理介面
- 新增代理規則（CLAUDE.md）、版號自動進位與發佈腳本、git hooks
