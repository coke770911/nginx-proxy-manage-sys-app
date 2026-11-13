# WAF 防護操作手冊（ModSecurity v3 + OWASP CRS）

管理系統可以替每個網域開啟網站應用程式防火牆（WAF），在 Nginx 解開 SSL 之後、轉給後端之前檢查請求，擋下 SQL 注入、XSS、路徑穿越、指令注入、弱點掃描器等攻擊。

| 項目 | 內容 |
|---|---|
| WAF 引擎 | ModSecurity v3（Ubuntu 套件 `libnginx-mod-http-modsecurity`、`libmodsecurity3t64`） |
| 規則集 | OWASP Core Rule Set 3.3（Ubuntu 套件 `modsecurity-crs`，隨安全更新自動更新） |
| 設定方式 | 管理系統「WAF 防護」分頁（全域）＋ 網域規則編輯視窗（各網域），按「一鍵同步部署」生效 |
| 需要的權限 | 安裝套件需 sysadmin（root）一次；之後的開關與調整都由管理系統透過 deployer 部署，**不需要新增 sudo 權限** |

---

## 1. 架構

```
使用者 ─► F5 VIP ─► Nginx 節點（解開 SSL → WAF 檢查 → 轉給後端）─► 後端系統
```

部署到節點 `/etc/nginx/sites-managed/` 的檔案：

| 檔案 | 內容 | 產生條件 |
|---|---|---|
| `_waf.conf` | http 層載入一次主規則檔（`modsecurity_rules_file`） | 總開關開啟，且至少一個網域不是「關閉」 |
| `_waf_main.rules` | ModSecurity 基本設定、CRS 設定（嚴格程度、門檻）、`Include` CRS 規則 | 同上 |
| `<網域>.conf` | `modsecurity on;` 與 `modsecurity_rules 'SecRuleEngine On / DetectionOnly …'`、排除規則 ID | 該網域為「僅偵測」或「阻擋」 |

- 總開關關閉、或沒有網域開啟 WAF 時，**不產生任何 WAF 檔案**，設定與未導入 WAF 前完全相同。
- `/f5-health-check` 一律不經過 WAF；維護中頁面也不經過 WAF。
- 設定檔沿用原本的部署流程：全部節點 `nginx -t` 通過才 reload，任一失敗即回滾。
- **稽核紀錄（audit log）刻意關閉**：它會記下 POST 內容（含登入密碼）。WAF 事件會寫入 Nginx 的 `error.log`，用管理介面「檢視 Nginx Log」查看。
- 大型上傳只檢查前段內容（`SecRequestBodyLimitAction ProcessPartial`），不會因為檔案太大被擋。
- 管理介面只開放「模式三選一」與「數字規則 ID」，**不提供自訂 ModSecurity 規則**（規則語法可以執行外部程式，有安全風險）。

---

## 2. 在節點安裝 WAF 模組

### 2-1 新節點

[節點建置操作手冊](節點建置操作手冊.md) 第 4 節的初始化腳本已包含步驟 `7d`，照手冊建置即會安裝，不需另外操作。

### 2-2 既有節點（每台各做一次，兩台輪流）

以 `sysadmin` SSH 登入節點後執行：

```bash
sudo apt-get update
sudo apt-get -y install libnginx-mod-http-modsecurity modsecurity-crs
for f in /usr/lib/nginx/modules/ngx_http_modsecurity_module.so \
         /etc/nginx/modules-enabled/50-mod-http-modsecurity.conf \
         /etc/nginx/unicode.mapping \
         /usr/share/modsecurity-crs/rules/REQUEST-901-INITIALIZATION.conf; do
  [ -e "$f" ] && echo "OK  $f" || echo "!! 缺少 $f"
done
sudo nginx -t && sudo systemctl reload nginx
dpkg-query -W libnginx-mod-http-modsecurity libmodsecurity3t64 modsecurity-crs
```

- 四行都是 `OK`、`nginx -t` 顯示 `syntax is ok` / `test is successful` 即完成。
- 這一步只載入模組，**不會開始檢查任何請求**，網站不受影響。
- 回到管理系統按節點旁的「重新檢測」，節點卡片會顯示「WAF 模組：已安裝（CRS 3.3.x）」。

### 2-3 移除（不再使用 WAF 時）

先在管理系統關閉總開關並部署，確認 `sites-managed/` 已沒有 `_waf*` 檔案，再執行：

```bash
sudo apt-get -y remove libnginx-mod-http-modsecurity modsecurity-crs
sudo nginx -t && sudo systemctl reload nginx
```

---

## 3. 管理系統設定

### 3-1 全域設定（「WAF 防護」分頁）

| 設定 | 說明 | 建議值 |
|---|---|---|
| WAF 總開關 | 關閉時所有網域都不檢查 | 開啟 |
| 嚴格程度（Paranoia Level） | 1 標準 / 2 加強 / 3 嚴格 / 4 極嚴格；越高擋得越多，誤判也越多 | 1 |
| 阻擋門檻分數 | 命中規則累加分數（嚴重 5、錯誤 4、警告 3），達門檻判定為攻擊 | 5 |

分頁右側會顯示各節點模組是否已安裝。有節點未安裝時，開啟 WAF 的部署會在**寫入任何檔案前**中止，並提示要安裝的節點。

### 3-2 各網域（網域規則編輯視窗）

| 欄位 | 說明 |
|---|---|
| WAF 防護 | 關閉（預設）/ 僅偵測（只記錄）/ 阻擋（回 403） |
| WAF 排除規則 | 被誤擋時填入規則 ID（6–7 位數字，逗號分隔），這個網域就不套用那些規則 |

規則清單的「WAF」欄會顯示各網域狀態；總開關關閉時以灰色顯示「尚未生效」。

---

## 4. 導入步驟（建議）

1. 兩台節點完成第 2 節安裝，節點卡片都顯示「WAF 模組：已安裝」。
2. 「WAF 防護」分頁：總開關開啟、嚴格程度 1、門檻 5，儲存。
3. 先挑一個測試網域（例如 testssl1）設「僅偵測」，一鍵同步部署。
4. 驗證有偵測到（在自己的電腦執行，網址換成測試網域）：
   ```bash
   curl -sk -o /dev/null -w "%{http_code}\n" "https://testssl1.aeust.edu.tw/?id=1%27%20OR%201=1--"
   curl -sk -o /dev/null -w "%{http_code}\n" "https://testssl1.aeust.edu.tw/?q=<script>alert(1)</script>"
   ```
   僅偵測模式仍會回正常狀態碼；到「檢視 Nginx Log」→ error.log，關鍵字搜尋 `ModSecurity`，應看到 `[id "942100"]`、`[id "941100"]` 之類的紀錄，`client:` 應是你的真實 IP。
5. 把測試網域改「阻擋」再部署，同樣的請求應回 `403`。
6. 其他網域全部改「僅偵測」，觀察 **1–2 週**，處理誤判（第 5 節）。
7. 從對外、風險高的網域（portal、www）開始，逐一改成「阻擋」。

---

## 5. 誤判處理

1. 使用者回報某功能被擋（403），或在「僅偵測」期間的 error.log 看到正常操作被記錄。
2. 「檢視 Nginx Log」→ error.log，關鍵字填網域或 `ModSecurity`，找到該次請求，記下 `[id "xxxxxx"]`（同一請求可能有多條）。
   - `949110`（Inbound Anomaly Score Exceeded）是「總分超標」的結果，**不要排除它**，要排除的是前面累加分數的那幾條。
3. 編輯該網域規則 → 「WAF 排除規則」填入那些 ID → 儲存 → 一鍵同步部署。
4. 請使用者再試一次。

常見誤判來源：ASP.NET 的 `__VIEWSTATE`、富文字編輯器（HTML 內容）、含 SQL 字樣的搜尋框、舊系統的特殊參數、大量 Cookie。

---

## 6. 常見問題

| 狀況 | 原因 / 處理 |
|---|---|
| 部署出現「有節點尚未安裝 WAF 模組」 | 依第 2-2 節在該節點安裝，再重新部署 |
| `nginx -t` 失敗、訊息含 `modsecurity` | 系統已自動回滾。檢查節點套件是否完整（第 2-2 節的檢查迴圈），或 CRS 套件更新後路徑改變 |
| 開啟 WAF 後網站變慢 | 嚴格程度調回 1；觀察節點卡片 CPU。大型上傳只檢查前段，不應明顯變慢 |
| error.log 的 `client:` 都是 F5 的 IP | PROXY protocol 沒有生效，WAF 看不到真實來源，請先處理（README「真實客戶端 IP」） |
| 想暫時全部停用 | 「WAF 防護」分頁關閉總開關 → 部署，所有網域立即回到未檢查狀態，網域上的設定保留 |
| CRS 規則更新 | `modsecurity-crs` 屬 Ubuntu universe，安全更新可能較慢；可在節點執行 `sudo apt-get install --only-upgrade modsecurity-crs && sudo nginx -t && sudo systemctl reload nginx` |

> Claude 協助操作的流程見 `.claude/skills/nginx-waf/SKILL.md`。
