---
name: nginx-node-ops
description: Nginx HA Proxy Manager 既有節點伺服器的日常維運：健康檢查、唯讀安全稽核、重新加固 / 補設定、Ubuntu 系統更新與重開機、SSH 允許網段與 fail2ban 管理、Nginx Log 權限、節點連不上（IP 衝突）排查。使用者說「檢查節點」「節點安全設定」「稽核」「更新 Ubuntu」「加 SSH 網段」「解除封鎖」「節點連不上」「IP 衝突」「重新加固」時使用。建置新節點請改用 deploy-nginx-node。
---

# Nginx 節點日常維運

建置新節點用 `deploy-nginx-node`；本 skill 處理**已上線節點**。初始化 / 加固腳本只有一份：`.claude/skills/deploy-nginx-node/node-setup.sh`（與 `docs/節點建置操作手冊.md` 第 4 節內嵌版本須保持一致）。全程以繁體中文回報。

## 安全底線

- **密碼一律由使用者輸入**（sudo、vCenter、console 登入）。需要 root 的指令整理成貼上區塊交給使用者，Claude 只用 deployer 金鑰做唯讀檢查。
- deployer 的 sudo 只有 `nginx -t` 與 `systemctl reload nginx`，不要嘗試其他 sudo。
- **不修改任何 vSphere VM 管理參數**（網路、電源、硬體、快照）。vCenter 裡只做查詢；改列表顯示欄位可以，但要說明那只是 UI 偏好。
- 真實 IP、MAC、指紋、允許網段只在對話中回報，不寫進進版控檔案。檔案裡一律用 `<IP>`、`x.x.33.0/24` 這類佔位。
- 一次只動一台節點（更新、重開機、重跑腳本），確認恢復 ONLINE 再處理下一台，避免兩台同時離線。

## 前置：取得節點清單

從 DB 讀節點（DB 連線資料取自 `backend/.env`，密碼只走 `SQLCMDPASSWORD`，絕不輸出）：

```bash
cd backend && set -a && . <(grep -E '^DB_(HOST|PORT|NAME|USER|PASSWORD)=' .env | tr -d '\r') && set +a && \
SQLCMDPASSWORD="$DB_PASSWORD" sqlcmd -S "$DB_HOST,${DB_PORT:-1433}" -U "$DB_USER" -d "$DB_NAME" -C -b -W -s " | " -Q "
SET NOCOUNT ON; SELECT NodeName, IpAddress, IsActive, HealthStatus, HealthMessage FROM dbo.ProxyNodes;"
```

以下 `<KEY>` = `C:/nginx-ha-manager/keys/deployer_ed25519`（以 `backend/.env` 的 `SSH_KEY_PATH` 為準）。

## 1. 健康檢查（Claude 直接執行）

```bash
ssh -i <KEY> -o BatchMode=yes -o ConnectTimeout=8 deployer@<IP> "sudo -n /usr/sbin/nginx -t 2>&1; systemctl is-active nginx fail2ban; uptime -p; df -h / | tail -1"
```

系統自己的健康檢查（會更新 DB 的 HealthStatus）：

```bash
cd backend && timeout 60 node -e "
const h=require('./src/services/healthService');const {ProxyNode}=require('./src/models');
(async()=>{await h.checkAllNodes();for(const x of await ProxyNode.findAll({raw:true}))console.log(x.NodeName,x.IpAddress,x.IsActive,x.HealthStatus,x.HealthMessage);process.exit(0)})().catch(e=>{console.error(e.message);process.exit(1)})" 2>&1 | grep -v '^Executing'
```

預期每台 `ONLINE nginx: active`。連不上 → 跳第 7 節。

## 2. 唯讀安全稽核（Claude 直接執行）

```bash
tr -d '\r' < .claude/skills/nginx-node-ops/node-audit.sh | ssh -i <KEY> -o BatchMode=yes -o ConnectTimeout=8 deployer@<IP> 'bash -s'
```

`tr -d '\r'` 必加（Windows 換行會讓 bash 出錯）。兩台都跑，並列比對。對照表：

| 區塊 | 預期 | 不符時 |
|---|---|---|
| 待更新 / 重開機 | 數字小（phased updates 會留幾個，屬正常）；`no reboot required` | 第 4 節 |
| SSHD | `10-hardening.conf` 存在，含 `PermitRootLogin no`、`X11Forwarding no`、`MaxAuthTries 3`、`LoginGraceTime 30`、`AllowUsers sysadmin deployer`。主設定檔裡的 `X11Forwarding yes` 會被 drop-in 蓋掉（先讀到的值生效），不是問題 | 第 3 節重跑腳本 |
| 密碼登入 | sysadmin 有金鑰時 10-hardening.conf 會多一行 `PasswordAuthentication no`；沒有就仍允許密碼（由網段限制 + fail2ban 防護） | 第 5-3 節 |
| UFW | `ENABLED=yes`、INPUT/FORWARD `DROP`。**規則內容 deployer 讀不到**，要使用者跑 `sudo ufw status numbered` 確認 22 只對允許網段 ALLOW、沒有 `OpenSSH ... Anywhere` | 第 5 節 |
| 監聽埠 | 對外只有 22、80、443；53 / 323 只在 127.x 或 ::1 | 查是哪個服務 |
| fail2ban | `active`；ignoreip 含所有允許網段；`banaction = ufw` | 第 3 / 5 節 |
| 自動更新 | `unattended-upgrades: active`，20auto-upgrades 兩行都是 `"1"` | 第 3 節 |
| 帳號 | uid0 只有 root；可登入 shell 只有 root / sysadmin / deployer；sudo 群組只有 sysadmin；sudoers.d 只有 `README`、`nginx-deployer` | 有多的帳號立即回報使用者 |
| Nginx | `server_tokens off;`、`include /etc/nginx/sites-managed/*.conf;`；sites-managed `drwxr-xr-x deployer`、ssl `drwxr-x--- deployer`；sites-enabled 為空；server header 為 `Server: nginx`（無版本） | 第 3 節 |
| Nginx Log | `user:deployer:r-x`、`default:user:deployer:r--`、可讀 access.log；logrotate `daily / rotate 365 / maxage 365` | 第 3 節 |
| sysctl | syncookies 1、accept/send_redirects 0、accept_source_route 0、ip_forward 0、randomize_va_space 2、kptr/dmesg_restrict 1 | 第 3 節 |
| 其他 | apparmor active、時區 Asia/Taipei、NTPSynchronized=yes、ModemManager/udisks2/upower inactive | 第 3 節 |
| 網卡 | 記下 MAC，第 7 節比對 IP 衝突用 | |

回報時用表格列「項目 / node1 / node2 / 判定」，只列差異與缺口，最後給建議。

## 3. 重新加固 / 補設定

`node-setup.sh` 可重複執行，**既有節點重跑就會補齊所有設定**（含 Log ACL、logrotate、SSH 網段、fail2ban、sysctl）。注意它會先 `apt full-upgrade`，若核心有更新事後要排重開機（第 4 節）。

1. 讀 `.claude/skills/deploy-nginx-node/node-setup.sh`，替換：
   - `__PUBKEY__` → `<KEY>.pub` 的內容（公鑰，可顯示）
   - `__SSH_ALLOW_NETS__` → 允許網段，空白分隔 CIDR。使用者說 `x.x.33.*` 就寫 `x.x.33.0/24`（`*` 不合法，腳本會擋）。**必須包含管理主機所在網段**（PowerShell `Get-NetIPAddress -AddressFamily IPv4` 查）。
2. 組成貼上區塊交給使用者，在已登入 sysadmin 的 SSH 視窗整段貼上（會要一次 sudo 密碼）。替換後的內容只放在對話，不寫回檔案：
   ```bash
   cat > ~/node-setup.sh <<'EOF'
   <替換後的 node-setup.sh 全文>
   EOF
   sudo bash ~/node-setup.sh
   ```
3. apt 出現紫色「Daemons using outdated libraries」對話框 → 請使用者直接按 Enter。
4. 使用者回報 `===== 全部完成 =====` 後，Claude 跑第 2 節稽核 + 第 1 節健康檢查確認。
5. 一台完成、ONLINE 後才換下一台。

## 4. Ubuntu 系統更新與重開機（使用者執行）

自動安全更新（unattended-upgrades）每天會跑，只裝 security 套件、**不會自動重開機**。手動完整更新給使用者：

```bash
sudo apt update && sudo apt full-upgrade -y
apt list --upgradable          # 剩下的多半是 phased updates（分批推送），過幾天自然會裝，不必強制
[ -f /var/run/reboot-required ] && cat /var/run/reboot-required.pkgs || echo "不需重開機"
```

需要重開機時：

1. 一次只重開一台：`sudo reboot`
2. Claude 等約 1 分鐘後跑第 1 節健康檢查，確認 ONLINE、`nginx -t` 通過，再處理另一台。
3. 查看自動更新紀錄：`less /var/log/unattended-upgrades/unattended-upgrades.log`

紫色「Daemons using outdated libraries」對話框按 Enter（預設會重啟受影響服務）。

## 5. SSH 允許網段與 fail2ban（使用者執行）

### 5-1 增加 / 移除 SSH 允許網段

```bash
sudo ufw allow from <網段/CIDR> to any port 22 proto tcp comment "SSH <網段>"
sudo ufw status numbered
sudo ufw delete <編號>          # 移除時：先確認自己目前的來源 IP 還在其他允許規則內，否則會斷線
```

同時把網段加進 fail2ban 白名單，編輯 `/etc/fail2ban/jail.d/sshd.local` 的 `ignoreip`（空白分隔），再 `sudo systemctl restart fail2ban`。也可以直接用新的網段清單重跑第 3 節腳本（兩邊一起更新）。兩台節點要設一樣。

### 5-2 fail2ban 查詢 / 解除封鎖

```bash
sudo fail2ban-client status sshd                 # 目前封鎖的 IP
sudo fail2ban-client set sshd unbanip <IP>       # 解除
sudo fail2ban-client get sshd ignoreip           # 白名單
```

允許網段本身已列白名單，不會被封；被封的是允許網段以外的來源（但它們本來就過不了 ufw）。

### 5-3 關閉 sysadmin 密碼登入

1. 使用者在自己的電腦產生 / 選定金鑰，`ssh-copy-id sysadmin@<IP>`（或手動放進 `~/.ssh/authorized_keys`）。
2. **另開一個視窗**確認能用金鑰登入。
3. 重跑第 3 節腳本：偵測到 sysadmin 有 `authorized_keys` 就會加 `PasswordAuthentication no`。
4. 原視窗不要關，用新視窗確認仍能登入後才結束。

## 6. Nginx Log（管理介面「檢視 Log」）

後端以 deployer 讀 `/var/log/nginx`，靠 ACL 授權（不加入 adm 群組），logrotate 每天切檔、保留 365 天。

- 檢查：`ssh ... deployer@<IP> "getfacl -p /var/log/nginx; tail -n 3 /var/log/nginx/error.log"`
- 讀不到（`Permission denied`）→ 第 3 節重跑腳本（步驟 7b / 7c 會補）。
- 磁碟：`df -h /var/log`；一年的壓縮 Log 量通常不大，若空間不足再調 `rotate`。

## 6b. WAF 模組

既有節點補裝、確認、誤判處理見 `nginx-waf` skill 與 `docs/WAF防護操作手冊.md`。重跑第 3 節腳本也會補裝（步驟 7d）。

## 7. 節點連不上 / 時好時壞

### 7-1 先分辨症狀（Claude 在管理主機執行）

```powershell
Test-NetConnection <IP> -Port 22
Test-NetConnection <IP> -Port 443
ping -n 4 <IP>
```

| 症狀 | 意義 |
|---|---|
| 逾時（TcpTestSucceeded False、無回應） | 節點關機、網路斷、或來源不在 SSH 允許網段（ufw DROP 不回應） |
| **被拒（refused / RST）而且每個埠都一樣** | 節點的 ufw 是 DROP，不會回 RST → **很可能是別台主機在回應同一個 IP（IP 衝突）** |
| ping 通但 SSH 不通 | 檢查 fail2ban 封鎖（5-2）、sshd 狀態 |
| 時好時壞 | 典型 IP 衝突：gateway 的 ARP 在兩台之間切換 |

### 7-2 確認 IP 衝突

**A. 從同網段的另一台節點**（使用者在另一台的 SSH 執行）：

```bash
ip -br link                                  # 找網卡名稱（例 ens33）
sudo apt install -y arping
sudo arping -0 -c 5 -I <網卡> <可疑 IP>      # 注意是 -0（來源 0.0.0.0），Ubuntu 26.04 的 arping 是 Habets 版，-D 不會顯示回應
ip neigh show <可疑 IP>
```

回應的 MAC 不等於該節點自己的 MAC（第 2 節稽核「網卡」區塊、或 console 上 `ip -br link`）→ 確定衝突。出現兩個不同 MAC 也一樣。

**B. 在節點 console 確認封包有沒有進來**（使用者在 vSphere console 執行；console 會吃掉 Shift，指令避開大寫與 `|:^` 等符號）：

```bash
grep -i tcp /proc/net/snmp
```

Claude 從管理主機連幾次 `Test-NetConnection <IP> -Port 22`，請使用者再跑一次。`InSegs` 沒增加 = 封包根本沒到這台，被別台搶走了。

### 7-3 找出搶 IP 的 VM（只查，不改）

- VMware 自動產生的 MAC `00:50:56:XX:..`，第 4 組 XX 每個 vCenter 不同。用既有 VM 的 MAC 比對，就能判斷衝突的 MAC 屬於哪個 vCenter。
- 請使用者登入該 vCenter 後，Claude 用 Claude in Chrome 操作：**資料中心 → 虛擬機器** 分頁 → 欄位選擇器加上「IP 位址」「MAC 位址」→ 篩選框輸入 MAC 末兩組（例 `ab:cd`）。直接搜尋 IP / MAC 字串常找不到，要用欄位篩選。
- 回報 VM 名稱、所有網卡的 MAC 與 IP、電源狀態。**不修改任何 VM 設定**；處理方式（改對方 IP、或 node 換 IP）由使用者與該 VM 管理者決定。
- 若改的是節點 IP：使用者改 `/etc/netplan/*.yaml` → `sudo netplan apply`（在 console 做，SSH 會斷），再更新 DB `ProxyNodes.IpAddress`（`deploy-nginx-node` 第 6 節的 UPDATE），最後跑第 1 節。

### 7-4 修好之後

Claude 從管理主機跑第 1 節健康檢查，並連續測幾次 `Test-NetConnection <IP> -Port 22` 確認穩定。

## 8. vSphere Web Console 操作提醒

- 先點右上角 **Enforce US Keyboard Layout**，再點畫面取得焦點。
- 打字會吃掉 Shift：大寫、`!@#$%^&*()_+{}|:"<>?~` 都打不出來。指令改用小寫與 `grep -i`；密碼請使用者自己輸入。
- 用完提醒使用者 `exit` 登出 console。

## 9. 收尾回報

- 用表格回報每台的結果、發現的缺口與已修正項目。
- 需要使用者動手的指令放在 `bash` 程式碼區塊，一個區塊一件事。
- 變更了 skill / 手冊 / 腳本時，提醒 commit 前要更新 README（pre-commit 檢查），push 前用 `npm run release`。
