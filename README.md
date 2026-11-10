# Nginx HA Proxy Manager

目前版本：**v1.0.0**

校園網域反向代理與 SSL 憑證集中管理系統（控制層）。管理員於網頁維護「網域 → 後端」規則與憑證，按下「一鍵同步部署」後，後端以 SSH/SFTP 平行推送到兩台 Ubuntu 24.04 Nginx，**兩台 `nginx -t` 都通過才 reload，任一失敗自動回滾**。

```
├─ CLAUDE.md                    代理規則（版號、README、安全規範）
├─ VERSION                      版號唯一來源（由 npm run release 維護）
├─ scripts/                     version.js 版號規則、release.js 發佈腳本
├─ .githooks/                   pre-commit（檢查 README）、pre-push（檢查版號 tag）
├─ database/schema.sql          SQL Server DDL + 兩台節點範例資料
├─ backend/                     Node.js + Express + Sequelize(mssql)
│  └─ src/
│     ├─ app.js                 進入點（API Token、靜態檔、健康檢查排程）
│     ├─ config/ db/ models/    設定、連線、4 張資料表 Model
│     ├─ routes/proxyRoutes.js  REST API + SSE 即時 Log
│     └─ services/
│        ├─ certService.js      憑證解析 / 公私鑰比對 / PFX 轉檔
│        ├─ nginxTemplate.js    .conf 生成器（含欄位白名單驗證）
│        ├─ sshSession.js       SSH+SFTP 連線封裝（可驗證主機金鑰）
│        ├─ deployService.js    雙機兩階段部署與回滾引擎
│        └─ healthService.js    節點燈號（SSH + nginx active）
└─ frontend/                    Vue 3 + Vite + Element Plus（src/views/Dashboard.vue）
```

## 快速開始

```bash
# 1. 建資料庫（SSMS 或 sqlcmd 執行）
sqlcmd -S <host> -U sa -i database/schema.sql

# 2. 後端
cd backend && cp .env.example .env   # 填入 DB、SSH_KEY_PATH、API_TOKEN
npm install && npm start             # 控制層主機需安裝 openssl（PFX 轉檔用）

# 3. 前端
cd frontend && npm install
npm run dev                          # 開發：http://localhost:5173（/api 代理到 :3000）
npm run build                        # 正式：產生 dist/，後端會自動以 Express 提供
```

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
- **認證**：目前以 `API_TOKEN` 簡易保護；若需 AD/LDAP 登入可在 `authGuard` 處替換。
- 版本相容：Ubuntu 24.04 的 nginx 為 1.24，故使用 `listen 443 ssl http2;`；升級至 ≥1.25.1 後可改 `http2 on;`。
- 自訂 Nginx 語法插入 443 server 區塊（位於 `location /` 之前），僅檢查大括號成對，語法正確性由 `nginx -t` 把關。

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

### v1.0.0

- 初始版本：SQL Server 資料表結構、Express 後端、憑證解析與 PFX 轉檔、雙機兩階段部署與回滾引擎、Vue 3 管理介面
- 新增代理規則（CLAUDE.md）、版號自動進位與發佈腳本、git hooks
