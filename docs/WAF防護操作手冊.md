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
- **稽核紀錄（audit log）刻意關閉**：它會記下 POST 內容（含登入密碼）。WAF 事件改寫入 `/var/log/nginx/waf.log`（見下方說明），用管理介面「檢視 Nginx Log」→「WAF 事件」查看。
- **WAF 事件 Log**：ModSecurity 把每條命中的規則記在 Nginx 的 **info** 等級，只有「阻擋」結果（`949110 Access denied`）是 error 等級。因此開啟 WAF 的網域會另寫一份 info 等級的 `waf.log`（含個別規則 ID），`error.log` 維持原本等級，只會看到阻擋那一行。`waf.log` 沿用 `/var/log/nginx` 的 ACL 與 logrotate（保留一年）。
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

### 3-3 全域設定與網域設定的優先順序

由上往下判斷，前面的條件先決定：

| 順序 | 設定 | 範圍 | 作用 |
|---|---|---|---|
| 1 | WAF 總開關 | 全域 | 關閉時所有網域都不檢查，網域上的設定全部不生效（但會保留） |
| 2 | 維護模式 | 網域 | 維護中的網域不經過 WAF |
| 3 | WAF 防護（關閉 / 僅偵測 / 阻擋） | 網域 | 這個網域要不要檢查、命中後只記錄還是回 403 |
| 4 | 嚴格程度（1–4） | 全域 | 決定載入哪些規則；嚴格程度 N 會載入 PL1～PLN 的所有規則 |
| 5 | WAF 排除規則 ID | 網域 | 從第 4 步的規則中拿掉這些 ID，**只影響這個網域** |
| 6 | 阻擋門檻分數 | 全域 | 用剩下的規則累加分數，達門檻才判定為攻擊 |

**排除規則的優先權高於全域嚴格程度**：設定檔中，http 層先載入全域規則（`_waf_main.rules`），各網域的 server 區塊再以 `SecRuleRemoveById` 移除自己排除的 ID，因此不論嚴格程度設多高，被排除的規則在該網域都不會執行；其他網域不受影響。

例：全域嚴格程度 3

| 網域設定 | 結果 |
|---|---|
| portal 沒填排除 | PL1～PL3 規則全部檢查 |
| portal 排除 `942100,942430` | 只有這兩條在 portal 不執行，其他網域照樣檢查 |
| portal 排除 `942432`（PL4 規則） | 沒有效果也沒有壞處，因為嚴格程度 3 本來就沒載入它 |

注意事項：

1. **調高嚴格程度會出現新的誤判**（例如 1 → 3 會多出 942110、942120、920300 等規則）。建議先把網域改回「僅偵測」觀察，補好排除再改回「阻擋」。
2. **調低嚴格程度時排除不必刪**，留著不影響，之後調高仍會生效。
3. **排除只能「少檢查」，不能「多檢查」**：嚴格程度與門檻目前只有全域設定，無法讓單一網域更嚴格。
4. **不要排除 `949110`**（總分結算）：排除後該網域等於永遠不會阻擋，只剩紀錄。

**實測紀錄（2026-11-13，testssl1，阻擋模式，經 F5 VIP 測試，兩台節點結果相同）**

| 全域嚴格程度 | testssl1 排除 | SQL 注入 `?id=1' OR 1=1--` | XSS `?q=<script>…` | 一般頁面 |
|---|---|---|---|---|
| 1 | 無 | **403**（命中 942100，5 分） | **403**（941100 / 941110 / 941160，15 分） | 200 |
| 1 | `942100` | **200**（942100 不再執行，總分 0） | **403**（排除只影響 942100） | 200 |
| 3 | `942100` | **403**（942100 仍不執行，但多出 PL2 規則 942130 / 942180 / 942330 / 942390，20 分） | — | 200 |

結論：網域排除確實蓋過全域設定、只影響指定的規則 ID；但調高嚴格程度後會有新的規則命中，需要依 `waf.log` 再補排除。

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
   僅偵測模式仍會回正常狀態碼；到「檢視 Nginx Log」→「WAF 事件 waf.log」，應看到 `[id "942100"]`、`[id "941100"]` 之類的紀錄，`client:` 應是你的真實 IP。
   - 部署（reload）後請**等約 5 秒**再測試：剛 reload 時舊的 worker 可能還在處理連線，會出現「沒被偵測 / 沒被擋」的假象。
5. 把測試網域改「阻擋」再部署，同樣的請求應回 `403`；`error.log` 會出現 `[id "949110"]` 的 `Access denied` 紀錄，`waf.log` 以紅色標示。
6. 其他網域全部改「僅偵測」，觀察 **1–2 週**，處理誤判（第 5 節）。
7. 從對外、風險高的網域（portal、www）開始，逐一改成「阻擋」。

---

## 5. 誤判處理

1. 使用者回報某功能被擋（403），或在「僅偵測」期間的 waf.log 看到正常操作被記錄。
2. 「檢視 Nginx Log」→「WAF 事件 waf.log」，關鍵字填網域或 IP，找到該次請求，記下 `[id "xxxxxx"]`（同一請求可能有多條）。
   - `949110`（Inbound Anomaly Score Exceeded）是「總分超標」的結果，**不要排除它**，要排除的是前面累加分數的那幾條。
3. 編輯該網域規則 → 「WAF 排除規則」填入那些 ID → 儲存 → 一鍵同步部署。
4. 請使用者再試一次。

各代碼代表的行為與常見誤擋情況見第 7 節。

常見誤判來源：ASP.NET 的 `__VIEWSTATE`、富文字編輯器（HTML 內容）、含 SQL 字樣的搜尋框、舊系統的特殊參數、大量 Cookie。

---

## 6. 常見問題

| 狀況 | 原因 / 處理 |
|---|---|
| 部署出現「有節點尚未安裝 WAF 模組」 | 依第 2-2 節在該節點安裝，再重新部署 |
| `nginx -t` 失敗、訊息含 `modsecurity` | 系統已自動回滾。檢查節點套件是否完整（第 2-2 節的檢查迴圈），或 CRS 套件更新後路徑改變 |
| 開啟 WAF 後網站變慢 | 嚴格程度調回 1；觀察節點卡片 CPU。大型上傳只檢查前段，不應明顯變慢 |
| waf.log / error.log 的 `client:` 都是 F5 的 IP | PROXY protocol 沒有生效，WAF 看不到真實來源，請先處理（README「真實客戶端 IP」） |
| 「WAF 事件」顯示節點上還沒有 waf.log | 尚未有網域開啟 WAF 並部署過；開啟後第一次部署才會建立 |
| 剛部署完測試沒反應 | reload 後舊 worker 還在處理連線，等約 5 秒再測 |
| 想暫時全部停用 | 「WAF 防護」分頁關閉總開關 → 部署，所有網域立即回到未檢查狀態，網域上的設定保留 |
| CRS 規則更新 | `modsecurity-crs` 屬 Ubuntu universe，安全更新可能較慢；可在節點執行 `sudo apt-get install --only-upgrade modsecurity-crs && sudo nginx -t && sudo systemctl reload nginx` |

---

## 7. WAF 檢查與阻擋的項目（規則代碼對照）

以下依節點實際安裝的 OWASP CRS 3.3.8（`/usr/share/modsecurity-crs/rules/`）整理，搭配本系統預設：**嚴格程度 1、阻擋門檻 5**。

### 7-1 判定方式：累加分數，不是單條規則就擋

1. 每個請求會跑過所有規則，命中一條就依嚴重等級加分：

   | 嚴重等級 | 分數 | 說明 |
   |---|---|---|
   | CRITICAL（嚴重） | 5 | 幾乎所有攻擊類規則（SQLi、XSS、命令注入…） |
   | ERROR（錯誤） | 4 | 回應內容外洩類（本系統未檢查回應內容，見 7-5） |
   | WARNING（警告） | 3 | 協定不標準，例如沒有 Host、編碼異常 |
   | NOTICE（注意） | 2 | 輕微異常，例如沒有 User-Agent、Accept 是空的 |

2. 請求讀完後由 **`949110`（Inbound Anomaly Score Exceeded）** 結算：總分 ≥ 門檻（5）即判定為攻擊。
   - **阻擋**模式：回 **HTTP 403**，`error.log` 與 `waf.log` 都會出現 `949110 … Access denied`。
   - **僅偵測**模式：照常放行，只在 `waf.log` 記錄。
3. 門檻 5 的意思：**一條 CRITICAL 就會擋**；WARNING / NOTICE 單獨命中不會擋，要累加（例如 3 + 2）才會。
4. 同一個請求通常會命中好幾條（例如 SQLi 會同時命中 942100 和其他 942xxx），`waf.log` 會一條一條列出，最後一行是 949110。

> **誤判時要排除的是前面加分的規則，不是 949110。** 排除 949110 等於整個網域不阻擋。

### 7-2 規則分類（代碼前三碼 = 類別）

「PL1 條數」= 嚴格程度 1（目前設定）實際生效的規則數；調高嚴格程度會再加上更嚴的規則。

| 代碼 | 類別 | 檢查的行為 | PL1 條數 | 會不會擋 |
|---|---|---|---|---|
| 911xxx | 請求方法 | 只允許 `GET HEAD POST OPTIONS`；`PUT` / `DELETE` / `PATCH` 等一律計分 | 1 | **會**（CRITICAL） |
| 913xxx | 掃描工具 | User-Agent / 標頭 / 檔名是已知掃描器（nikto、sqlmap、nmap、acunetix…） | 3 | **會** |
| 920xxx | HTTP 協定規範 | 請求格式、編碼、標頭、Content-Type、副檔名是否合規（詳見 7-3） | 36 | 部分會（見 7-3） |
| 921xxx | 協定攻擊 | HTTP 請求走私、回應分割、標頭注入（參數夾帶 CR/LF） | 8 | **會** |
| 922xxx | Multipart 攻擊 | 上傳表單（multipart）標頭字元集、編碼不合規 | 4 | **會** |
| 930xxx | 本機檔案引入（LFI） | 路徑穿越 `../`、存取 `/etc/passwd`、`.htaccess`、`web.config` 等系統 / 敏感檔 | 4 | **會** |
| 931xxx | 遠端檔案引入（RFI） | 參數帶外部 URL（IP 網址、`?` 結尾、常見漏洞參數名） | 3 | **會** |
| 932xxx | 遠端命令執行（RCE） | Unix / Windows 命令注入、PowerShell、Shellshock、上傳 shell 腳本 | 12 | **會** |
| 933xxx | PHP 注入 | `<?php`、上傳 .php、危險函式（`system`、`eval`）、序列化物件 | 11 | **會** |
| 934xxx | Node.js 注入 | `require('child_process')` 之類的程式碼 | 1 | **會** |
| 941xxx | 跨站腳本（XSS） | `<script>`、`onerror=`、`javascript:`、各種編碼繞過、JSFuck | 24 | **會** |
| 942xxx | SQL 注入（SQLi） | `' OR 1=1`、`UNION SELECT`、`sleep()`、`benchmark()`、MSSQL / MySQL / PostgreSQL 特有語法 | 16 | **會** |
| 943xxx | Session 固定攻擊 | 參數夾帶 Session ID 或設定 Cookie 的 HTML | 3 | **會** |
| 944xxx | Java 攻擊 | Java 反序列化（CVE-2015-4852）、Struts（CVE-2017-9805）、可疑 Java 類別 | 4 | **會** |
| 949110 | 結算（請求） | 總分 ≥ 門檻 → 阻擋模式回 403 | — | 結果 |
| 980xxx | 統計紀錄 | 只記錄各類分數，不影響結果 | — | 不會 |
| 200002 | 本系統自訂 | POST 的 JSON / XML 內容格式錯誤，無法解析 | — | **會**（回 **400**） |

### 7-3 協定規範（920xxx）常見代碼

| 代碼 | 行為 | 等級 | 單獨會擋？ |
|---|---|---|---|
| 920100 | 請求第一行格式錯誤 | WARNING | 否 |
| 920120 | 上傳檔名夾帶可疑字元，企圖繞過 multipart 檢查 | CRITICAL | **會** |
| 920160 | `Content-Length` 不是數字 | CRITICAL | **會** |
| 920170 / 920171 | GET / HEAD 卻帶有內容（body / Transfer-Encoding） | CRITICAL | **會** |
| 920180 | POST 沒有 `Content-Length` 也沒有 `Transfer-Encoding` | WARNING | 否 |
| 920220 / 920240 / 920250 | URL / UTF-8 編碼濫用 | WARNING | 否 |
| 920270 | 請求含 NULL 字元（`%00`） | CRITICAL | **會** |
| 920280 / 920290 | 沒有 Host 標頭 / Host 是空的 | WARNING | 否 |
| 920310 / 920311 / 920330 | Accept 是空的 / User-Agent 是空的 | NOTICE | 否 |
| 920340 | 有內容但沒有 Content-Type | NOTICE | 否 |
| 920350 | Host 是 IP 位址（直接用 IP 連） | WARNING | 否 |
| 920420 | **Content-Type 不在允許清單**（見下方） | CRITICAL | **會** |
| 920430 | HTTP 版本不是 1.0 / 1.1 / 2 | CRITICAL | **會** |
| 920440 | **網址副檔名在禁止清單**（見下方） | CRITICAL | **會** |
| 920450 | **帶有禁止的標頭**（見下方） | CRITICAL | **會** |
| 920470 / 920480 / 920530 | Content-Type 格式錯誤 / 字元集不允許 / 多個字元集 | CRITICAL | **會** |
| 920500 | 存取編輯器留下的備份檔（檔名以 `~` 結尾，例如 `index.php~`） | CRITICAL | **會** |
| 920600 / 920620 | Accept 字元集參數非法 / 重複的 Content-Type 標頭 | CRITICAL | **會** |

CRS 預設允許 / 禁止清單（本系統沿用預設，未修改）：

| 項目 | 內容 |
|---|---|
| 允許的方法（911100） | `GET` `HEAD` `POST` `OPTIONS` |
| 允許的 Content-Type（920420） | `application/x-www-form-urlencoded`、`multipart/form-data`、`text/xml`、`application/xml`、`application/soap+xml`、`application/json` |
| 允許的字元集（920480） | `utf-8`、`iso-8859-1`、`iso-8859-15`、`windows-1252` |
| 允許的 HTTP 版本（920430） | `HTTP/1.0`、`HTTP/1.1`、`HTTP/2`、`HTTP/2.0` |
| 禁止的副檔名（920440） | `.asa` `.asax` `.ascx` `.axd` `.backup` `.bak` `.bat` `.cdx` `.cer` `.cfg` `.cmd` `.com` `.config` `.conf` `.cs` `.csproj` `.csr` `.dat` `.db` `.dbf` `.dll` `.dos` `.htr` `.htw` `.ida` `.idc` `.idq` `.inc` `.ini` `.key` `.licx` `.lnk` `.log` `.mdb` `.old` `.pass` `.pdb` `.pol` `.printer` `.pwd` `.rdb` `.resources` `.resx` `.sql` `.swp` `.sys` `.vb` `.vbs` `.vbproj` `.vsdisco` `.webinfo` `.xsd` `.xsx` |
| 禁止的標頭（920450） | `Accept-Charset`、`Content-Encoding`、`Proxy`、`Lock-Token`、`Content-Range`、`If` |

### 7-4 導入時最容易誤擋的情況

| 情況 | 會命中 | 處理 |
|---|---|---|
| REST API 使用 `PUT` / `DELETE` / `PATCH` | 911100 | 該網域排除 `911100` |
| 上傳用 `text/plain`、`application/octet-stream` 或其他 Content-Type | 920420 | 排除 `920420` |
| 網站真的提供 `.config`、`.log`、`.dat`、`.db` 等副檔名的下載 | 920440 | 排除 `920440` |
| 舊系統或特定瀏覽器送出 `Accept-Charset` 標頭 | 920450 | 排除 `920450` |
| ASP.NET `__VIEWSTATE`、富文字編輯器送出 HTML | 941xxx（XSS） | 依 `waf.log` 的 ID 排除 |
| 搜尋框、備註欄打出含 SQL 字樣的內容（`select … from`、單引號） | 942xxx（SQLi） | 依 `waf.log` 的 ID 排除 |
| 表單欄位內容含 Linux / Windows 指令字樣（例如資訊課程教材） | 932xxx（RCE） | 依 `waf.log` 的 ID 排除 |

### 7-5 目前**沒有**作用的規則

| 代碼 | 類別 | 原因 |
|---|---|---|
| 903.9xxx | WordPress / Drupal / Nextcloud 等應用程式專用排除 | CRS 預設不啟用，本系統未開啟 |
| 910xxx | IP 信譽、高風險國家 | 需要 GeoIP 資料庫與黑名單服務，未設定 |
| 912xxx | DoS 防護 | 需另外設定頻率門檻，未設定（流量防護請交給 F5） |
| 920360 / 920370 / 920380 / 920390 / 920400 / 920410 | 參數個數、長度、上傳大小上限 | CRS 預設不設上限；上傳大小由網域的「上傳檔案上限」控制 |
| 950xxx–954xxx、959100 | 回應內容外洩（SQL 錯誤訊息、原始碼、目錄列表） | 本系統關閉回應內容檢查（`SecResponseBodyAccess Off`），避免拖慢網站 |
| PL2–PL4 規則 | 例如 913101（curl / python 等腳本 User-Agent）、942110 / 942120 等更嚴格的 SQLi 規則 | 嚴格程度 1 不啟用；調到 2 以上才生效，誤判會明顯增加 |

### 7-6 查詢完整規則

以 deployer 登入節點，列出某一類別的規則 ID 與說明（例：942 SQLi）：

```bash
grep -oE "id:942[0-9]+|msg:'[^']*'" /usr/share/modsecurity-crs/rules/REQUEST-942-APPLICATION-ATTACK-SQLI.conf | paste - -
```

---

> Claude 協助操作的流程見 `.claude/skills/nginx-waf/SKILL.md`。
