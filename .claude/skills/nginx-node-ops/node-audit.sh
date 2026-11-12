#!/bin/bash
# Nginx 節點唯讀安全稽核（以 deployer 身分執行，不需要 root，不修改任何設定）
# 用法（管理主機）：
#   ssh -i C:/nginx-ha-manager/keys/deployer_ed25519 -o BatchMode=yes deployer@<IP> 'bash -s' < node-audit.sh
# 每段的「預期」寫在 SKILL.md 的稽核對照表。

echo "## OS"; . /etc/os-release; echo "$PRETTY_NAME"; uname -r; uptime -p
echo "## 待更新 / 重開機"
apt list --upgradable 2>/dev/null | grep -vc '^Listing'
[ -f /var/run/reboot-required ] && echo "REBOOT REQUIRED: $(cat /var/run/reboot-required.pkgs 2>/dev/null | tr '\n' ' ')" || echo "no reboot required"

echo "## SSHD（設定檔；50-cloud-init.conf 權限 600 讀不到屬正常）"
ls -l /etc/ssh/sshd_config.d/ 2>/dev/null
grep -hEi '^\s*(PermitRootLogin|PasswordAuthentication|KbdInteractiveAuthentication|MaxAuthTries|X11Forwarding|AllowUsers|LoginGraceTime)' \
  /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf 2>/dev/null || true

echo "## UFW（規則內容 deployer 讀不到，只看啟用狀態與預設政策）"
grep -E '^ENABLED' /etc/ufw/ufw.conf; printf 'ufw service: '; systemctl is-active ufw
grep -E '^DEFAULT_(INPUT|OUTPUT|FORWARD)_POLICY' /etc/default/ufw

echo "## 監聽埠"
ss -tlnH | awk '{print "tcp " $4}' | sort -u
ss -ulnH | awk '{print "udp " $4}' | sort -u

echo "## fail2ban"
printf 'fail2ban: '; systemctl is-active fail2ban 2>/dev/null || true
grep -E '^(ignoreip|banaction|maxretry|findtime|bantime)' /etc/fail2ban/jail.d/sshd.local 2>/dev/null || echo "(無 sshd.local)"

echo "## 自動更新"
printf 'unattended-upgrades: '; systemctl is-active unattended-upgrades 2>/dev/null || true
cat /etc/apt/apt.conf.d/20auto-upgrades 2>/dev/null
ls -t /var/log/unattended-upgrades/ 2>/dev/null | head -3

echo "## 帳號"
awk -F: '$3==0{print "uid0: "$1}' /etc/passwd
awk -F: '$7!~/(nologin|false|sync)$/{print "login-shell: "$1" ("$7")"}' /etc/passwd
getent group sudo
ls -l /etc/sudoers.d/

echo "## Nginx"
nginx -v 2>&1
grep -nE '^\s*server_tokens|sites-managed' /etc/nginx/nginx.conf
ls -ld /etc/nginx/sites-managed /etc/nginx/ssl
ls /etc/nginx/sites-enabled/ 2>/dev/null
printf 'managed confs: '; ls /etc/nginx/sites-managed/ 2>/dev/null | wc -l
printf 'server header: '; curl -sI --max-time 3 http://127.0.0.1/ | grep -i '^server' || echo "(無回應)"

echo "## Nginx Log（deployer 唯讀、保留一年）"
getfacl -p /var/log/nginx 2>/dev/null | grep -E 'deployer' || echo "!! /var/log/nginx 沒有 deployer ACL"
tail -n 1 /var/log/nginx/access.log >/dev/null 2>&1 && echo "deployer 可讀 access.log：OK" || echo "!! deployer 讀不到 access.log"
grep -E '^\s*(daily|rotate|maxage)' /etc/logrotate.d/nginx 2>/dev/null

echo "## sysctl"
for k in net.ipv4.tcp_syncookies net.ipv4.conf.all.rp_filter net.ipv4.conf.all.accept_redirects \
         net.ipv4.conf.all.send_redirects net.ipv4.conf.all.accept_source_route net.ipv4.ip_forward \
         kernel.randomize_va_space kernel.kptr_restrict kernel.dmesg_restrict; do
  printf '%s = %s\n' "$k" "$(sysctl -n "$k" 2>/dev/null)"
done

echo "## AppArmor / 時間 / 服務"
printf 'apparmor: '; systemctl is-active apparmor
timedatectl show -p NTPSynchronized -p Timezone 2>/dev/null
for s in ModemManager udisks2 upower; do printf '%s: ' "$s"; systemctl is-active "$s" 2>/dev/null || true; done

echo "## 網卡（MAC 用於 IP 衝突比對）"
ip -br link | grep -v '^lo'
ip -br -4 addr | grep -v '^lo'
echo "===== 稽核完成 ====="
