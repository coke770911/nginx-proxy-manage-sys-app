---
name: nginx-waf
description: Nginx HA Proxy Manager 的 WAF（ModSecurity v3 + OWASP CRS）安裝與維運：在節點安裝 / 確認 WAF 模組、開啟或調整 WAF、驗證偵測與阻擋、查 WAF 事件、處理誤判（排除規則 ID）、WAF 造成部署失敗或網站被擋的排查。使用者說「WAF」「ModSecurity」「CRS」「網站被擋 403」「誤判」「排除規則」「裝 WAF」「開啟防火牆防護」時使用。新節點建置用 deploy-nginx-node（其初始化腳本已含 WAF 安裝）。
---

# WAF 安裝與維運

完整說明在 `docs/WAF防護操作手冊.md`，本 skill 是 Claude 的操作流程。全程以繁體中文回報。

## 安全底線

- 安裝 / 移除套件需要 root：整理成貼上區塊交給使用者以 sysadmin 執行，**密碼由使用者輸入**。Claude 只用 deployer 金鑰做唯讀檢查。
- deployer 的 sudo 只有 `nginx -t` 與 `systemctl reload nginx`；WAF 開關都走管理系統部署，**不要為了 WAF 增加 sudo 權限**。
- 不在設定檔或管理系統加入自訂 ModSecurity 規則文字（`SecRule` 可執行外部程式）。只能用：模式（off / detect / block）、數字規則 ID 排除、全域嚴格程度 1–4、門檻 1–100。修改 `wafService.js` / `nginxTemplate.js` 時，所有寫進設定檔的值都必須經過 `validateRule()` / `validateSettings()` 白名單驗證。
- 不開 ModSecurity audit log（會記下 POST 內容與密碼）。
- 一次只動一台節點；真實 IP 只在對話中回報，不寫進版控檔案。

## 架構速查

| 位置 | 內容 |
|---|---|
| `backend/src/services/wafService.js` | 白名單驗證、`_waf.conf` / `_waf_main.rules` 產生、`WAF_CHECK_CMD`（輸出 `WAF:<0/1>:<CRS 版本>`） |
| `backend/src/services/nginxTemplate.js` | 各網域 server 區塊的 `modsecurity on;` + `modsecurity_rules 'SecRuleEngine …'`；`/f5-health-check` 加 `modsecurity off;` |
| `backend/src/services/deployService.js` | 有網域開 WAF 時，連線後先跑 `WAF_CHECK_CMD`，任一節點未安裝 → 寫入前中止 |
| `backend/src/services/wafSettingsService.js` | 全域設定（資料表 `WafSettings`，只有 Id=1） |
| DB | `DomainRules.WafMode`（off/detect/block）、`DomainRules.WafExcludeIds`；`database/schema.sql` 可重複執行補欄位 |
| 節點套件 | `libnginx-mod-http-modsecurity`、`libmodsecurity3t64`、`modsecurity-crs`（CRS 3.3.x，規則在 `/usr/share/modsecurity-crs/rules`） |

總開關關閉或沒有網域開啟時，不產生任何 WAF 檔案，設定與導入前完全相同。

## 1. 確認節點模組（Claude 直接執行）

```bash
ssh -i <KEY> -o BatchMode=yes deployer@<IP> "echo WAF:\$(test -e /usr/lib/nginx/modules/ngx_http_modsecurity_module.so && test -e /etc/nginx/modules-enabled/50-mod-http-modsecurity.conf && test -e /etc/nginx/unicode.mapping && test -d /usr/share/modsecurity-crs/rules && echo 1 || echo 0):\$(dpkg-query -W -f='\${Version}' modsecurity-crs 2>/dev/null); nginx -v 2>&1"
```

`WAF:1:3.3.x` = 已安裝；`WAF:0:` = 未安裝。管理介面節點卡片（`WAF：ModSecurity x · CRS y`，另一行顯示 OS 與 nginx 版本，來自 healthService 的 `VERSION_CMD`）與「WAF 防護」分頁也會顯示（健康檢查時更新）。

## 2. 安裝（使用者以 sysadmin 執行，一次一台）

交給使用者貼上（與 `docs/WAF防護操作手冊.md` 第 2-2 節相同）：

```bash
sudo apt-get update
sudo apt-get -y install libnginx-mod-http-modsecurity modsecurity-crs
for f in /usr/lib/nginx/modules/ngx_http_modsecurity_module.so /etc/nginx/modules-enabled/50-mod-http-modsecurity.conf /etc/nginx/unicode.mapping /usr/share/modsecurity-crs/rules/REQUEST-901-INITIALIZATION.conf; do [ -e "$f" ] && echo "OK  $f" || echo "!! 缺少 $f"; done
sudo nginx -t && sudo systemctl reload nginx
```

只載入模組、不檢查請求，網站不受影響。完成後跑第 1 節確認，再處理下一台。新節點的 `deploy-nginx-node/node-setup.sh` 步驟 7d 已包含。

**不安裝也能驗證規則檔語法**（deployer 即可，在節點 /tmp 解開官方套件，用完即刪）：

```bash
X=$(mktemp -d) && cd $X && apt-get download libnginx-mod-http-modsecurity modsecurity-crs libmodsecurity3t64 libgeoip1t64 liblua5.3-0 libfuzzy2 libyajl2 >/dev/null 2>&1 \
 && for f in *.deb; do dpkg-deb -x $f $X; done \
 && sed "s#/etc/nginx/unicode.mapping#$X/etc/nginx/unicode.mapping#; s#/usr/share/modsecurity-crs#$X/usr/share/modsecurity-crs#" <產生的 _waf_main.rules> > main.rules \
 && LD_LIBRARY_PATH=$X/usr/lib/x86_64-linux-gnu $X/usr/lib/x86_64-linux-gnu/libexec/modsec-rules-check main.rules; cd /; rm -rf $X
```

預期 `Loaded 9xx rules. Test ok.`

## 3. 開啟與驗證

1. 確認所有啟用節點都是 `WAF:1`。
2. 請使用者在「WAF 防護」分頁開啟總開關（嚴格程度 1、門檻 5），測試網域設「僅偵測」，一鍵同步部署。部署紀錄應出現「WAF 已啟用…」與各節點「WAF 模組已安裝」。
3. 確認節點上的檔案：`ssh ... deployer@<IP> "ls -l /etc/nginx/sites-managed/_waf*; grep -n modsecurity /etc/nginx/sites-managed/<網域>.conf"`
4. 送測試請求：
   ```bash
   curl -sk -o /dev/null -w "%{http_code}\n" "https://<網域>/?id=1%27%20OR%201=1--"
   curl -sk -o /dev/null -w "%{http_code}\n" "https://<網域>/?q=<script>alert(1)</script>"
   ```
5. 查事件：`ssh ... deployer@<IP> "grep -F ModSecurity /var/log/nginx/waf.log | tail -n 5"`，應有 `[id "942100"]` / `[id "941100"]` 與 `client: <真實 IP>`。
   - 個別規則命中是 Nginx **info** 等級，只寫在 `waf.log`（各 WAF 網域的 `error_log ... waf.log info;`）；`error.log` 只有阻擋結果 `949110 Access denied`。
   - reload 後等約 5 秒再測，避免打到舊 worker 造成假陰性。
6. 改「阻擋」再部署，同樣請求應回 `403`。

## 4. 誤判處理

1. 找事件：`grep -F ModSecurity /var/log/nginx/waf.log | grep -F '<網域>' | tail -n 50`（或請使用者用管理介面「檢視 Nginx Log」搜尋）。
2. 整理該請求命中的 `[id "…"]`（網域排除優先於全域嚴格程度，見操作手冊 3-3；已實測 testssl1 排除 942100 有效）；**不要排除 949110 / 959100 / 980130**（總分判定與彙總），要排除的是累加分數的個別規則。
3. 請使用者在該網域的「WAF 排除規則」填入 ID（逗號分隔）→ 儲存 → 部署；或確認後由 Claude 以 API 修改。
4. 常見誤判：ASP.NET `__VIEWSTATE`（942xxx）、富文字 HTML（941xxx）、含 SQL 字樣的搜尋、Cookie 過多 / 過長（920xxx）。
5. 規則代碼對照、計分方式、CRS 預設禁止清單（`PUT/DELETE/PATCH` → 911100、非允許 Content-Type → 920420、`.config/.log/.bak` 等副檔名 → 920440、`Accept-Charset` 等標頭 → 920450）見操作手冊第 7 節；回答「WAF 擋了什麼」時以該節為準，需要時用第 7-6 節指令在節點查最新規則。

## 5. 故障排查

| 狀況 | 處理 |
|---|---|
| 部署「有節點尚未安裝 WAF 模組」 | 第 2 節裝好該節點後重新部署 |
| `nginx -t` 失敗含 `modsecurity` / `Rules error` | 已自動回滾；依第 2 節最後一段在 /tmp 驗證 `_waf_main.rules`；檢查 CRS 套件更新後路徑 |
| 整站 403 | 先請使用者把該網域改「僅偵測」或關總開關並部署止血，再查事件找規則 |
| waf.log `client:` 是 F5 IP | PROXY protocol 未生效（README「真實客戶端 IP」），WAF 看不到真實來源 |
| 網站變慢 | 嚴格程度回 1；看節點 CPU；大型上傳只檢查前段 |

## 6. 回報

告訴使用者：各節點模組狀態與 CRS 版本、哪些網域在偵測 / 阻擋、測試請求結果、找到的誤判與建議排除的規則 ID、尚未驗證的項目。
