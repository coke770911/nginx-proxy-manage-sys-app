#!/bin/bash
# Nginx HA Proxy Manager 節點初始化（Ubuntu 26.04）
# 使用前把 __PUBKEY__ 換成管理主機 deployer_ed25519.pub 的內容；可重複執行。
set -euo pipefail

PUBKEY='__PUBKEY__'
export DEBIAN_FRONTEND=noninteractive

case "$PUBKEY" in ssh-ed25519\ *) ;; *) echo "!! PUBKEY 尚未替換"; exit 1;; esac

echo "== 1. 時區 =="
timedatectl set-timezone Asia/Taipei

echo "== 2. 系統更新 + 安裝 nginx / open-vm-tools =="
apt-get update
apt-get -y full-upgrade
apt-get -y install nginx open-vm-tools

echo "== 3. 防火牆 =="
ufw allow OpenSSH
ufw allow 80,443/tcp
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

echo "== 6. nginx.conf 加入 sites-managed =="
if ! grep -q 'sites-managed/\*\.conf' /etc/nginx/nginx.conf; then
  cp /etc/nginx/nginx.conf /etc/nginx/nginx.conf.bak
  sed -i '/include \/etc\/nginx\/sites-enabled\/\*;/a\        include /etc/nginx/sites-managed/*.conf;' /etc/nginx/nginx.conf
fi
grep -q 'sites-managed/\*\.conf' /etc/nginx/nginx.conf || { echo "!! include 加入失敗，請手動檢查 nginx.conf"; exit 1; }
rm -f /etc/nginx/sites-enabled/default

echo "== 7. sudoers（只允許 nginx -t 與 reload）=="
cat > /tmp/nginx-deployer <<'SUDO'
deployer ALL=(root) NOPASSWD: /usr/sbin/nginx -t
deployer ALL=(root) NOPASSWD: /usr/bin/systemctl reload nginx
SUDO
visudo -cf /tmp/nginx-deployer
install -m 440 -o root -g root /tmp/nginx-deployer /etc/sudoers.d/nginx-deployer
rm -f /tmp/nginx-deployer

echo "== 8. 驗證 =="
nginx -t
systemctl enable --now nginx
systemctl reload nginx
nginx -v
sudo -u deployer sudo -n /usr/sbin/nginx -t && echo "deployer 免密碼 sudo：OK"
ufw status
echo "主機指紋："
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
echo "===== 全部完成 ====="
