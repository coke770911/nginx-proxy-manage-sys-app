'use strict';
/**
 * 節點維運操作（管理介面節點卡片的「重開機」「更新套件」按鈕）
 *
 * 節點需另外在 sudoers 允許（見 node-setup.sh 第 7 節、nginx-node-ops/install-node-upgrade.sh）：
 *   deployer ALL=(root) NOPASSWD: /usr/bin/systemctl reboot
 *   deployer ALL=(root) NOPASSWD: /usr/local/sbin/npm-node-upgrade start
 * 指令可由 .env NODE_REBOOT_CMD / NODE_UPGRADE_CMD 調整，必須與 sudoers 完全一致；以 sudo -n 執行，未授權時直接失敗。
 *
 * 更新套件：節點腳本在背景執行 apt-get update + full-upgrade + nginx -t，輸出寫入 /var/log/npm-node-upgrade.log（644），
 * 本系統以 deployer 讀檔取得進度（不需 sudo）；SSH 斷線不影響節點上的更新。
 *
 * 共同安全檢查（維持服務不中斷）：節點需啟用、不可在部署中、其他啟用中節點必須都是 ONLINE、
 * 同時只能有一台在更新、更新中的節點不可重開機。
 */
const config = require('../config');
const { ProxyNode } = require('../models');
const { NodeSession } = require('./sshSession');
const deployService = require('./deployService');

const REBOOT_GUARD_MS = 10 * 60000;
const UPGRADE_MAX_MS = 2 * 3600000; // 超過 2 小時仍未讀到結束，視為已結束（避免永遠鎖住）
const UPGRADE_LOG = '/var/log/npm-node-upgrade.log';
const UPGRADE_PID = '/run/npm-node-upgrade.pid';
const UPGRADE_SCRIPT = '/usr/local/sbin/npm-node-upgrade';
const LOG_LINES = 400;

const lastReboot = new Map(); // nodeId -> timestamp
const upgrading = new Map(); // nodeId -> { startedAt }

class NodeOpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const SUDO_DENIED_RE = /password is required|a terminal is required|not allowed|not in the sudoers|may not run|authentication/i;

const isUpgrading = (id) => {
  const u = upgrading.get(id);
  if (u && Date.now() - u.startedAt > UPGRADE_MAX_MS) upgrading.delete(id);
  return upgrading.has(id);
};
const anyUpgrading = () => [...upgrading.keys()].some(isUpgrading);

/** 共同檢查；what = 動作名稱（錯誤訊息用） */
async function assertCanOperate(node, what) {
  if (!node.IsActive) throw new NodeOpError(400, '節點已停用，請先啟用再操作');
  if (deployService.isRunning()) throw new NodeOpError(409, `部署進行中，請等部署結束再${what}`);
  const others = (await ProxyNode.findAll({ where: { IsActive: true } })).filter((n) => n.Id !== node.Id);
  const busy = others.filter((n) => isUpgrading(n.Id));
  if (busy.length) throw new NodeOpError(409, `${busy.map((n) => n.NodeName).join('、')} 正在更新套件，請等它完成後再${what}（一次只處理一台）`);
  const notReady = others.filter((n) => n.HealthStatus !== 'ONLINE');
  if (notReady.length) {
    throw new NodeOpError(409, `其他節點 ${notReady.map((n) => `${n.NodeName}（${n.HealthStatus}）`).join('、')} 目前不正常，${what}可能讓服務中斷；請等其他節點恢復 ONLINE 後再操作`);
  }
}

/** 開一條 SSH 執行指令；連線失敗轉成 NodeOpError */
async function withSession(node, fn) {
  const s = new NodeSession(node);
  try {
    await s.open({ sftp: false });
    return await fn(s);
  } catch (e) {
    if (e instanceof NodeOpError) throw e;
    throw new NodeOpError(502, `無法連線到節點：${String(e.message || e).slice(0, 300)}`);
  } finally {
    await s.close();
  }
}

const sudoHint = (line) => `請以 sysadmin 在節點執行 nginx-node-ops/install-node-upgrade.sh，或在 /etc/sudoers.d/nginx-deployer 加上：${line}`;

/* ------------------------------------------------------------------ 重開機 */
async function rebootNode(node) {
  await assertCanOperate(node, '重開機');
  if (isUpgrading(node.Id)) throw new NodeOpError(409, '此節點正在更新套件，請等更新完成再重開機');
  const last = lastReboot.get(node.Id);
  if (last && Date.now() - last < REBOOT_GUARD_MS) {
    throw new NodeOpError(429, `此節點 ${Math.ceil((REBOOT_GUARD_MS - (Date.now() - last)) / 60000)} 分鐘前才送出重開機，請稍候`);
  }
  await withSession(node, async (s) => {
    let r;
    try {
      r = await s.exec(config.ssh.rebootCmd, 15000);
    } catch (e) {
      r = { code: null, stdout: '', stderr: '' }; // 重開機時 SSH 可能直接被切斷或逾時，視為已送出
    }
    if (SUDO_DENIED_RE.test(r.stderr || '')) {
      throw new NodeOpError(403, `節點未授權 deployer 執行重開機（${String(r.stderr).trim().slice(0, 200)}）。${sudoHint('deployer ALL=(root) NOPASSWD: /usr/bin/systemctl reboot')}`);
    }
    if (r.code && r.code !== 0) throw new NodeOpError(502, `重開機指令失敗（exit ${r.code}）：${String(r.stderr || r.stdout).trim().slice(0, 300)}`);
  });
  lastReboot.set(node.Id, Date.now());
  await node.update({ HealthMessage: `重開機中（${new Date().toLocaleString('zh-TW', { hour12: false })} 送出）` });
  return { at: new Date().toISOString(), guardMinutes: REBOOT_GUARD_MS / 60000 };
}

/* ------------------------------------------------------------------ 更新套件 */
async function startUpgrade(node) {
  await assertCanOperate(node, '更新套件');
  if (isUpgrading(node.Id)) throw new NodeOpError(409, '此節點已在更新中');
  const r = await withSession(node, (s) => s.exec(config.ssh.upgradeCmd, 30000));
  const out = `${r.stdout}\n${r.stderr}`;
  if (SUDO_DENIED_RE.test(r.stderr || '') || /command not found|No such file/i.test(out)) {
    throw new NodeOpError(403, `節點尚未安裝更新腳本或未授權（${out.trim().slice(0, 200)}）。${sudoHint('deployer ALL=(root) NOPASSWD: /usr/local/sbin/npm-node-upgrade start')}`);
  }
  if (/NPM_ALREADY_RUNNING/.test(out)) {
    upgrading.set(node.Id, { startedAt: Date.now() });
    return { already: true };
  }
  if (!/NPM_STARTED/.test(out)) throw new NodeOpError(502, `更新腳本沒有正常啟動（exit ${r.code}）：${out.trim().slice(0, 300)}`);
  upgrading.set(node.Id, { startedAt: Date.now() });
  return { already: false };
}

// 讀取進度（唯讀、不需 sudo）
const STATUS_CMD = [
  `echo "NPM_INSTALLED:$([ -x ${UPGRADE_SCRIPT} ] && echo 1 || echo 0)"`,
  `echo "NPM_RUNNING:$([ -f ${UPGRADE_PID} ] && [ -d /proc/$(cat ${UPGRADE_PID} 2>/dev/null) ] && echo 1 || echo 0)"`,
  `echo "NPM_LOGTIME:$(stat -c %Y ${UPGRADE_LOG} 2>/dev/null)"`,
  'echo "NPM_LOG_BEGIN"',
  `tail -n ${LOG_LINES} ${UPGRADE_LOG} 2>/dev/null`,
].join('; ');

/**
 * 回傳 { installed, running, result: 'OK'|'FAIL'|null, failStep, rebootPkgs, lines, logAt, justFinished }
 * justFinished = 本系統送出的更新在這次讀取時發現已結束（供呼叫端寫操作紀錄、刷新更新資訊）
 */
async function upgradeStatus(node) {
  const r = await withSession(node, (s) => s.exec(STATUS_CMD, 20000));
  const out = String(r.stdout || '');
  const [head, log = ''] = out.split(/^NPM_LOG_BEGIN\s*$/m);
  const installed = /^NPM_INSTALLED:1/m.test(head);
  const running = /^NPM_RUNNING:1/m.test(head);
  const ts = head.match(/^NPM_LOGTIME:(\d+)/m);
  // 去掉 apt 的 \r 進度列，只保留最後狀態
  const lines = log.split('\n').map((l) => l.split('\r').pop().trimEnd()).filter((l, i, a) => l || i < a.length - 1);
  const res = log.match(/^NPM_RESULT:(OK|FAIL)(?::(\S+))?/m);
  const rb = log.match(/^NPM_REBOOT:(.*)$/m);
  let justFinished = false;
  if (!running && upgrading.has(node.Id)) {
    // 剛送出時腳本可能還沒寫 pid，送出 20 秒內不判定為結束
    if (res || Date.now() - upgrading.get(node.Id).startedAt > 20000) {
      upgrading.delete(node.Id);
      justFinished = true;
    }
  }
  return {
    installed,
    running: running || isUpgrading(node.Id),
    result: res ? res[1] : null,
    failStep: res && res[1] === 'FAIL' ? res[2] || null : null,
    rebootPkgs: rb ? rb[1].trim().split(/\s+/).filter(Boolean) : null,
    lines: lines.filter((l) => !/^NPM_(RESULT|REBOOT):/.test(l)),
    logAt: ts ? new Date(Number(ts[1]) * 1000).toISOString() : null,
    justFinished,
  };
}

module.exports = { rebootNode, startUpgrade, upgradeStatus, isUpgrading, anyUpgrading, NodeOpError };
