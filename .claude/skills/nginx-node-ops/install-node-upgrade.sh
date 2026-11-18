#!/bin/bash
# 既有節點：安裝管理介面「更新套件」「重開機」按鈕需要的腳本與 sudoers（以 sysadmin 執行：sudo bash install-node-upgrade.sh）
# 內容與 deploy-nginx-node/node-setup.sh 第 7、7e 節相同，兩邊修改時請保持一致。可重複執行。
set -euo pipefail

echo "== 安裝 /usr/local/sbin/npm-node-upgrade =="
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

echo "== sudoers（nginx -t、reload、重開機、更新套件）=="
cat > /tmp/nginx-deployer <<'SUDO'
deployer ALL=(root) NOPASSWD: /usr/sbin/nginx -t
deployer ALL=(root) NOPASSWD: /usr/bin/systemctl reload nginx
deployer ALL=(root) NOPASSWD: /usr/bin/systemctl reboot
deployer ALL=(root) NOPASSWD: /usr/local/sbin/npm-node-upgrade start
SUDO
visudo -cf /tmp/nginx-deployer
install -m 440 -o root -g root /tmp/nginx-deployer /etc/sudoers.d/nginx-deployer
rm -f /tmp/nginx-deployer

sudo -l -U deployer | grep -E 'nginx|systemctl|npm-node-upgrade'
echo "===== 完成 ====="
