#!/bin/bash
# Nginx HA Proxy Manager 節點初始化 + 安全加固（Ubuntu 26.04）
# 使用前替換：
#   __PUBKEY__         → 管理主機 deployer_ed25519.pub 的內容
#   __SSH_ALLOW_NETS__ → 允許連 SSH 的網段（空白分隔 CIDR，須包含管理主機所在網段）
#   __PROXY_PROTOCOL_FROM__ → 選填：F5 送出連線的來源 IP（空白分隔），開放 PROXY protocol 埠 8080/8443；不用 F5 就保留原樣
# 可重複執行；既有節點重跑即可補上加固設定。
set -euo pipefail

PUBKEY='__PUBKEY__'
SSH_ALLOW_NETS='__SSH_ALLOW_NETS__'
PROXY_PROTOCOL_FROM='__PROXY_PROTOCOL_FROM__'
export DEBIAN_FRONTEND=noninteractive

case "$PUBKEY" in ssh-ed25519\ *) ;; *) echo "!! PUBKEY 尚未替換"; exit 1;; esac
for n in $SSH_ALLOW_NETS; do
  [[ "$n" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}/[0-9]{1,2}$ ]] || { echo "!! SSH_ALLOW_NETS 格式錯誤：$n（應為 x.x.x.x/nn）"; exit 1; }
done
[ "$PROXY_PROTOCOL_FROM" = '__PROXY_PROTOCOL_FROM__' ] && PROXY_PROTOCOL_FROM=''
for n in $PROXY_PROTOCOL_FROM; do
  [[ "$n" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}(/[0-9]{1,2})?$ ]] || { echo "!! PROXY_PROTOCOL_FROM 格式錯誤：$n（應為 x.x.x.x 或 x.x.x.x/nn）"; exit 1; }
done

echo "== 1. 時區 =="
timedatectl set-timezone Asia/Taipei

echo "== 2. 系統更新 + 安裝套件 =="
apt-get update
apt-get -y full-upgrade
apt-get -y install nginx open-vm-tools fail2ban python3-systemd unattended-upgrades

echo "== 3. 防火牆（80/443 對外，SSH 只開放指定網段）=="
ufw allow 80,443/tcp
for n in $SSH_ALLOW_NETS; do
  ufw allow from "$n" to any port 22 proto tcp comment "SSH $n"
done
for n in $PROXY_PROTOCOL_FROM; do
  ufw allow from "$n" to any port 8080,8443 proto tcp comment "PROXY protocol $n"
done
ufw delete allow OpenSSH >/dev/null 2>&1 || true   # 先加網段規則再刪全開規則，不會斷線
ufw --force enable

echo "== 4. deployer 帳號（僅金鑰登入）=="
id deployer >/dev/null 2>&1 || useradd -m -s /bin/bash deployer
usermod -p '*' deployer
install -d -m 700 -o deployer -g deployer /home/deployer/.ssh
echo "$PUBKEY" > /home/deployer/.ssh/authorized_keys
chown deployer:deployer /home/deployer/.ssh/authorized_keys
chmod 600 /home/deployer/.ssh/authorized_keys

echo "== 5. 系統管理目錄 =="
install -d -m 755 -o deployer -g deployer /etc/nginx/sites-managed
install -d -m 750 -o deployer -g deployer /etc/nginx/ssl

echo "== 6. nginx.conf 加入 sites-managed、隱藏版本號 =="
if ! grep -q 'sites-managed/\*\.conf' /etc/nginx/nginx.conf; then
  cp /etc/nginx/nginx.conf /etc/nginx/nginx.conf.bak
  sed -i '/include \/etc\/nginx\/sites-enabled\/\*;/a\        include /etc/nginx/sites-managed/*.conf;' /etc/nginx/nginx.conf
fi
grep -q 'sites-managed/\*\.conf' /etc/nginx/nginx.conf || { echo "!! include 加入失敗，請手動檢查 nginx.conf"; exit 1; }
sed -i 's/^\(\s*\)#\?\s*server_tokens\s\+\(build\|on\|off\);/\1server_tokens off;/' /etc/nginx/nginx.conf
grep -q '^\s*server_tokens off;' /etc/nginx/nginx.conf || sed -i '/http {/a\        server_tokens off;' /etc/nginx/nginx.conf
rm -f /etc/nginx/sites-enabled/default

echo "== 7. sudoers（只允許 nginx -t、reload 與管理介面的重開機、更新套件按鈕）=="
cat > /tmp/nginx-deployer <<'SUDO'
deployer ALL=(root) NOPASSWD: /usr/sbin/nginx -t
deployer ALL=(root) NOPASSWD: /usr/bin/systemctl reload nginx
deployer ALL=(root) NOPASSWD: /usr/bin/systemctl reboot
deployer ALL=(root) NOPASSWD: /usr/local/sbin/npm-node-upgrade start
SUDO
visudo -cf /tmp/nginx-deployer
install -m 440 -o root -g root /tmp/nginx-deployer /etc/sudoers.d/nginx-deployer
rm -f /tmp/nginx-deployer

echo "== 7a. 管理介面「更新套件」腳本（與 nginx-node-ops/install-node-upgrade.sh 內容相同，修改時兩邊保持一致）=="
cat > /tmp/npm-node-upgrade <<'UPG'
#!/bin/bash
# Managed by Nginx HA Proxy Manager：節點套件更新（管理介面「更新套件」按鈕以 sudo 執行，請勿手動修改）
# 用法：npm-node-upgrade start
#   在背景執行 apt-get update + full-upgrade + nginx -t，輸出寫入 /var/log/npm-node-upgrade.log（所有人可讀，
#   管理介面以 deployer 讀取進度，不需 sudo）。SSH 斷線不影響更新進行。
set -u
LOG=/var/log/npm-node-upgrade.log
PIDF=/run/npm-node-upgrade.pid
running() { [ -f "$PIDF" ] && [ -d "/proc/$(cat "$PIDF" 2>/dev/null)" ]; }
case "${1:-}" in
  start)
    if running; then echo "NPM_ALREADY_RUNNING"; exit 3; fi
    install -m 644 /dev/null "$LOG"
    setsid nohup "$0" run >>"$LOG" 2>&1 </dev/null &
    echo "NPM_STARTED"
    ;;
  run)
    [ "$(id -u)" = 0 ] || { echo "需要 root"; exit 1; }
    if running; then echo "NPM_ALREADY_RUNNING"; exit 3; fi
    echo $$ > "$PIDF"
    trap 'rm -f "$PIDF"' EXIT
    export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a
    step() { echo; echo "== $(date '+%F %T') $*"; }
    fail() { echo "NPM_RESULT:FAIL:$1"; exit 1; }
    step "1/4 更新套件清單（apt-get update）"
    apt-get -q -o DPkg::Lock::Timeout=600 update || fail update
    step "2/4 安裝更新（apt-get full-upgrade，設定檔衝突時保留現有設定）"
    apt-get -y -q -o DPkg::Lock::Timeout=600 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold full-upgrade || fail upgrade
    step "3/4 檢查 Nginx（nginx -t）"
    nginx -t || fail nginx-test
    systemctl is-active --quiet nginx || systemctl start nginx
    systemctl is-active nginx || fail nginx-down
    step "4/4 完成"
    echo "剩餘可更新套件：$(apt list --upgradable 2>/dev/null | grep -c 'upgradable from')（多為分批推送的 phased updates）"
    if [ -f /var/run/reboot-required ]; then echo "NPM_REBOOT:$(sort -u /var/run/reboot-required.pkgs 2>/dev/null | tr '\n' ' ')"; fi
    echo "NPM_RESULT:OK"
    ;;
  *) echo "用法：$0 start"; exit 2 ;;
esac
UPG
install -m 755 -o root -g root /tmp/npm-node-upgrade /usr/local/sbin/npm-node-upgrade
rm -f /tmp/npm-node-upgrade

echo "== 7b. 讓 deployer 唯讀 Nginx Log（管理介面「檢視 Log」用；只開 /var/log/nginx，不加入 adm 群組）=="
command -v setfacl >/dev/null 2>&1 || apt-get install -y acl
setfacl -m u:deployer:rx /var/log/nginx
setfacl -d -m u:deployer:r /var/log/nginx   # logrotate 新建的檔案自動繼承
setfacl -m u:deployer:r /var/log/nginx/*.log

echo "== 7c. Nginx Log 保留一年（每天切檔、壓縮，超過 365 天自動刪除）=="
cat > /etc/logrotate.d/nginx <<'ROTATE'
/var/log/nginx/*.log {
	daily
	missingok
	rotate 365
	maxage 365
	dateext
	dateformat -%Y%m%d
	compress
	delaycompress
	notifempty
	create 0640 www-data adm
	sharedscripts
	prerotate
		if [ -d /etc/logrotate.d/httpd-prerotate ]; then \
			run-parts /etc/logrotate.d/httpd-prerotate; \
		fi \
	endscript
	postrotate
		invoke-rc.d nginx rotate >/dev/null 2>&1
	endscript
}
ROTATE
logrotate -d /etc/logrotate.d/nginx >/dev/null 2>&1 || { echo "!! logrotate 設定檢查失敗"; exit 1; }

echo "== 7d. WAF 模組（ModSecurity v3 + OWASP CRS；只安裝不啟用，由管理系統部署時開啟）=="
apt-get -y install libnginx-mod-http-modsecurity modsecurity-crs
for f in /usr/lib/nginx/modules/ngx_http_modsecurity_module.so /etc/nginx/modules-enabled/50-mod-http-modsecurity.conf /etc/nginx/unicode.mapping /usr/share/modsecurity-crs/rules/REQUEST-901-INITIALIZATION.conf; do
  [ -e "$f" ] || { echo "!! WAF 安裝不完整，缺少 $f"; exit 1; }
done
nginx -t
echo "   WAF 模組已安裝：CRS $(dpkg-query -W -f='${Version}' modsecurity-crs)"

echo "== 8. SSH 加固 =="
cat > /etc/ssh/sshd_config.d/10-hardening.conf <<'EOF'
PermitRootLogin no
X11Forwarding no
MaxAuthTries 3
LoginGraceTime 30
AllowUsers sysadmin deployer
EOF
# 只有 sysadmin 已放公鑰時才關閉密碼登入，避免把自己鎖在外面
if [ -s /home/sysadmin/.ssh/authorized_keys ]; then
  echo "PasswordAuthentication no" >> /etc/ssh/sshd_config.d/10-hardening.conf
  sed -i 's/^PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config.d/50-cloud-init.conf 2>/dev/null || true
  echo "   已關閉密碼登入（sysadmin 有公鑰）"
else
  echo "   !! sysadmin 尚無公鑰，暫不關閉密碼登入（由網段限制 + fail2ban 防護）"
fi
sshd -t && systemctl reload ssh

echo "== 9. fail2ban（SSH 10 分鐘內失敗 5 次封鎖 1 小時，允許網段列白名單）=="
cat > /etc/fail2ban/jail.d/sshd.local <<EOF
[DEFAULT]
ignoreip = 127.0.0.1/8 ::1 ${SSH_ALLOW_NETS}
banaction = ufw
[sshd]
enabled  = true
backend  = systemd
maxretry = 5
findtime = 10m
bantime  = 1h
EOF
systemctl enable --now fail2ban
systemctl restart fail2ban

echo "== 10. 自動安全更新、核心網路參數、停用不需要的服務 =="
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
systemctl enable --now unattended-upgrades
cat > /etc/sysctl.d/90-hardening.conf <<'EOF'
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.default.send_redirects = 0
net.ipv4.conf.default.accept_redirects = 0
net.ipv6.conf.all.accept_redirects = 0
net.ipv4.conf.all.log_martians = 1
EOF
sysctl --system >/dev/null
systemctl disable --now ModemManager udisks2 upower 2>/dev/null || true

echo "== 11. 驗證 =="
nginx -t
systemctl enable --now nginx
systemctl reload nginx
nginx -v
sudo -u deployer sudo -n /usr/sbin/nginx -t && echo "deployer 免密碼 sudo：OK"
sshd -T | grep -Ei '^(permitrootlogin|passwordauthentication|x11forwarding|maxauthtries|allowusers)'
fail2ban-client get sshd ignoreip
ufw status numbered
echo "主機指紋："
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
echo "===== 全部完成 ====="
