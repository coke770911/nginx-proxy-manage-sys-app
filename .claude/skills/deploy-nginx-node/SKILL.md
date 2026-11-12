---
name: deploy-nginx-node
description: 在 vSphere 上建置一台新的 Ubuntu Server 26.04 Nginx 節點並接入 Nginx HA Proxy Manager（安裝 OS、固定 IP、執行節點初始化與安全加固腳本、金鑰驗證、登錄節點、健康檢查）。使用者說「建新節點」「部署伺服器」「架第二台 nginx」「把 VM 接進系統」「節點加固」時使用。
---

# 建置並接入 Nginx 節點

完整人工操作版見 `docs/節點建置操作手冊.md`；本 skill 是 Claude 代為操作的流程。全程以繁體中文回報。

## 安全底線（每一步都適用）

- **密碼一律由使用者自己輸入**：vCenter 登入、Ubuntu 安裝時的密碼、`sudo` 密碼。走到密碼欄位就停下來請使用者輸入，輸入完再繼續。
- **清空硬碟前必須取得使用者明確確認**（安裝程式的 `Confirm destructive action`）。確認前先截圖讓使用者核對 VM 名稱、硬碟大小。
- **SSL 私鑰 / PFX 不代為上傳**，只告訴使用者選哪個檔。不讀取 `憑證密碼.txt` 之類的密碼檔。
- 不把真實 IP、指紋、私鑰寫進任何會進版控的檔案；`backend/.env` 已被 git 忽略，可以改。
- 讀取 `backend/.env` 的 DB 密碼時只透過環境變數傳給 `sqlcmd`（`SQLCMDPASSWORD`），絕不輸出到畫面。

## 0. 收集資料

向使用者確認（缺什麼問什麼，一次問完）：

| 項目 | 例 |
|---|---|
| vSphere VM 名稱 | `SRV_Linux_NginxProxy2` |
| 節點名稱（系統內） | `nginx-node2` |
| 固定 IP / 遮罩 | `x.x.x.92 / 255.255.255.192` → 換算成 CIDR 與網段（/26 的網段 = IP 所在 64 區塊起點） |
| Gateway、DNS | |
| SSH 允許網段 | 管理人員與管理主機所在網段，例 `x.x.33.0/24 x.x.34.0/24`。**必須包含管理主機 IP**（PowerShell `Get-NetIPAddress -AddressFamily IPv4` 查），否則部署會連不上 |

## 1. 用 Claude in Chrome 操作 vSphere Web Console

1. `tabs_context_mcp {createIfEmpty:true}` 開一個分頁，請使用者自己登入 vCenter 並開啟該 VM 的 **LAUNCH WEB CONSOLE**（會開新分頁，之後就在 console 分頁操作）。
2. 先點右上角 **Enforce US Keyboard Layout**，再點一下畫面中央取得焦點。
3. **安裝程式只能用鍵盤**（`Up/Down/Tab/Return/space`），滑鼠點擊無效。每一步操作後截圖（scale 0.6 即可）或 zoom 確認焦點位置再按 Enter。
4. **Console 打字會吃掉 Shift**（大寫、`!@#` 會變小寫/數字），所以：顯示名稱接受小寫；提醒使用者安裝時密碼先用小寫英數，裝好後 SSH `passwd` 改。

依序：

| 畫面 | 操作 |
|---|---|
| GRUB | `Try or Install Ubuntu Server` → Return，等約 20–40 秒 |
| Language | English → Return |
| Keyboard | English (US) → Done |
| Type of installation | Ubuntu Server（非 minimized）→ Done |
| Network | Up 移到網卡列 → Return → Down×2 `Edit IPv4` → Return → Method 下拉選 `Manual` → Tab 依序填 Subnet / Address / Gateway / Name servers（逗號分隔）→ zoom 核對 → Tab 到 Save → Return；確認顯示 `static` → Done |
| Proxy | 留空 → Done |
| Mirror | 等到 `This mirror location passed tests.`（= 網路通）→ Done；失敗就回網路設定檢查 |
| Guided storage | Use an entire disk + LVM，不加密 → Done |
| Storage summary | `ubuntu-lv` → Edit → Size 改成括號內的 max 值（End、BackSpace 清掉再打）→ Save，確認 `/` 變最大、`No available devices` |
| Done → Confirm destructive action | **停下來問使用者**，得到確認才選 Continue |
| Profile | Your name `System Admin`、Server name `<節點名稱>`、Username `sysadmin`，Tab 到密碼欄後**停下來請使用者輸入兩次密碼** |
| Ubuntu Pro | Skip for now → Continue |
| SSH | 空白鍵勾 **Install OpenSSH server**（必勾）→ Done |
| Snaps | 全不勾 → Tab → Done |
| Installing | 每 ~90 秒截圖一次，直到 `Installation complete!` |
| Reboot Now | 選 Reboot Now；`Please remove the installation medium` 按 Return |
| 開機 | 等出現 `<節點名稱> login:`；zoom 開機訊息中 `ED25519` 的 `SHA256:...` 指紋並記下 |

## 2. 確認網路

```powershell
Test-NetConnection <IP> -Port 22
```

`TcpTestSucceeded : True` 後請使用者自己 `ssh sysadmin@<IP>` 登入（需要密碼，不代打），若用了臨時密碼請他 `passwd`。

## 3. 部署金鑰

檢查 `C:\nginx-ha-manager\keys\deployer_ed25519` 是否存在：

- **存在 → 沿用**，不要重產（重產會讓既有節點全部失效）。
- 不存在 → 產生（PowerShell 5.1 空 passphrase 要寫 `'""'`）：
  ```powershell
  New-Item -ItemType Directory -Force C:\nginx-ha-manager\keys | Out-Null
  ssh-keygen -q -t ed25519 -C "nginx-ha-manager" -N '""' -f C:\nginx-ha-manager\keys\deployer_ed25519
  ```

讀出 `deployer_ed25519.pub` 的內容（公鑰，可以顯示）。

## 4. 節點初始化腳本

讀取本 skill 目錄下的 `node-setup.sh`，把 `__PUBKEY__` 換成上一步的公鑰、`__SSH_ALLOW_NETS__` 換成第 0 步的 SSH 允許網段（空白分隔 CIDR；使用者說 `x.x.33.*` 就寫 `x.x.33.0/24`），組成下列貼上區塊交給使用者，在已登入的 SSH 視窗整段貼上（會要一次 sudo 密碼）。替換後的內容只在對話中提供，不寫回版控檔案。

腳本除了初始化，也完成安全加固：ufw 的 SSH 只開放允許網段（先加網段規則再刪 `OpenSSH` 全開規則）、SSH 禁 root / 關 X11 / `MaxAuthTries 3` / `AllowUsers sysadmin deployer`、fail2ban（允許網段列白名單）、`server_tokens off`、自動安全更新、sysctl、停用 ModemManager/udisks2/upower。sysadmin 有 `authorized_keys` 時才關閉密碼登入。**既有節點重跑同一腳本即可補上加固**（可重複執行）。若 apt 出現紫色「Daemons using outdated libraries」對話框，請使用者按 Enter。

```bash
cat > ~/node-setup.sh <<'EOF'
<node-setup.sh 內容，已替換公鑰>
EOF
sudo bash ~/node-setup.sh
```

等使用者回報 `===== 全部完成 =====`。若有錯誤，請他貼出最後的輸出再診斷。

## 5. 從管理主機驗證（Claude 直接執行）

```powershell
ssh -i C:\nginx-ha-manager\keys\deployer_ed25519 -o BatchMode=yes -o StrictHostKeyChecking=accept-new deployer@<IP> "sudo -n /usr/sbin/nginx -t 2>&1; sudo -n /usr/bin/systemctl reload nginx && echo RELOAD_OK; systemctl is-active nginx; nginx -v 2>&1; ls -ld /etc/nginx/sites-managed /etc/nginx/ssl; ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub"
```

必須同時成立：`syntax is ok`、`RELOAD_OK`、`active`、兩個目錄擁有者為 deployer（ssl 為 `drwxr-x---`）、**指紋與 console 記下的完全一致**（不一致立即停止並告知使用者）。nginx ≥ 1.25.1 時 `.env` 的 `NGINX_HTTP2_SYNTAX` 應為 `modern`，否則提醒改 `legacy`。

再確認加固結果：

```bash
ssh -i C:/nginx-ha-manager/keys/deployer_ed25519 -o BatchMode=yes deployer@<IP> "systemctl is-active fail2ban; cat /etc/ssh/sshd_config.d/10-hardening.conf; grep ignoreip /etc/fail2ban/jail.d/sshd.local; grep -n server_tokens /etc/nginx/nginx.conf; sysctl -n net.ipv4.conf.all.send_redirects"
curl -sI http://<IP>/ | grep -i '^server'
```

預期：fail2ban `active`、`PermitRootLogin no` 等 5 行、ignoreip 含允許網段、`server_tokens off;`、`0`、回應標頭為 `Server: nginx`（不含版本）。deployer 讀不到 ufw 規則，請使用者核對腳本輸出的 `ufw status numbered`：22/tcp 只對允許網段 ALLOW，且已無 `OpenSSH ... Anywhere`。

## 6. 接入系統

1. `backend/.env` 的 `SSH_KEY_PATH` 應為 `C:/nginx-ha-manager/keys/deployer_ed25519`；不是就用 sed 改該行，並 `git check-ignore backend/.env` 確認不進版控。
2. 寫入 / 更新節點（在專案根目錄的 Bash 執行；DB 連線資料取自 `backend/.env`）：
   ```bash
   cd backend && set -a && . <(grep -E '^DB_(HOST|PORT|NAME|USER|PASSWORD)=' .env | tr -d '\r') && set +a && \
   SQLCMDPASSWORD="$DB_PASSWORD" sqlcmd -S "$DB_HOST,${DB_PORT:-1433}" -U "$DB_USER" -d "$DB_NAME" -C -b -W -s " | " -Q "
   SET NOCOUNT ON;
   IF EXISTS (SELECT 1 FROM dbo.ProxyNodes WHERE NodeName=N'<節點名稱>')
     UPDATE dbo.ProxyNodes SET IpAddress=N'<IP>', SshPort=22, SshUser=N'deployer', SshKeyPath=NULL,
       HostKeySha256=N'<SHA256:指紋>', IsActive=1, UpdatedAt=SYSUTCDATETIME() WHERE NodeName=N'<節點名稱>';
   ELSE
     INSERT INTO dbo.ProxyNodes (NodeName, IpAddress, SshPort, SshUser, HostKeySha256, IsActive, HealthStatus)
     VALUES (N'<節點名稱>', N'<IP>', 22, N'deployer', N'<SHA256:指紋>', 1, N'UNKNOWN');
   SELECT NodeName, IpAddress, SshUser, IsActive, HostKeySha256 FROM dbo.ProxyNodes;"
   ```
3. 若列表中還有其他**仍是預設假 IP、尚未建置**的節點且為啟用狀態，告知使用者它會讓每次部署失敗回滾，詢問是否先停用（`IsActive=0`）。
4. 若後端在跑且 `.env` 有改，重新啟動（`preview_start` 名稱 `start`；先 `preview_stop` 舊的）。
5. 用系統自己的健康檢查確認：
   ```bash
   cd backend && timeout 60 node -e "
   const h=require('./src/services/healthService');const {ProxyNode}=require('./src/models');
   (async()=>{await h.checkAllNodes();for(const x of await ProxyNode.findAll({raw:true}))console.log(x.NodeName,x.IpAddress,x.IsActive,x.HealthStatus,x.HealthMessage);process.exit(0)})().catch(e=>{console.error(e.message);process.exit(1)})" 2>&1 | grep -v '^Executing'
   ```
   新節點應為 `ONLINE nginx: active`。

## 7. 收尾與回報

告訴使用者：

- 節點 IP、Nginx 版本、指紋已比對一致、健康檢查結果、加固項目驗證結果。
- 若 sysadmin 仍是密碼登入，說明目前由網段限制 + fail2ban 防護；設好 sysadmin 金鑰後重跑腳本即會關閉密碼登入。
- 允許網段以外（家中、其他 VPN 網段）將無法 SSH，只能走 vSphere console；需要時在 ufw 加網段或重跑腳本。
- 待辦：在 vSphere 取消 CD/DVD 的 Connected；上線前做一次故意寫錯自訂語法的部署確認會回滾；建立 VM 快照。
- 真實 IP / 指紋只在對話中回報，不寫進進版控的檔案。

## 附：上傳 SSL 憑證的檔案選擇

使用者問憑證時：用 `openssl x509 -noout -subject -enddate -ext subjectAltName`、`grep -c 'BEGIN CERTIFICATE'` 檢查公開資訊，用公鑰比對確認 key 與 cert 成對（不輸出私鑰內容）。告訴使用者選 `*_fullchain.crt` + `*.key`（或 PFX + 自己輸入密碼）；只含葉憑證的 `*.crt` 會產生「僅含葉憑證」警告，選錯時用「更新憑證」重傳。
