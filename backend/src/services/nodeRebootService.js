'use strict';
/**
 * 遠端節點重開機（管理介面節點卡片的「重開機」按鈕）
 *
 * 節點需另外在 sudoers 允許：deployer ALL=(root) NOPASSWD: /usr/bin/systemctl reboot
 * （見 node-setup.sh 第 7 節；指令可由 .env NODE_REBOOT_CMD 調整，必須與 sudoers 完全一致）
 *
 * 安全檢查（維持服務不中斷）：
 *  - 部署進行中不可重開機
 *  - 其他啟用中的節點必須都是 ONLINE，避免兩台同時離線（F5 會把流量全部轉給正常的節點）
 *  - 同一台 10 分鐘內只能重開一次，避免重複點擊
 * 指令以 sudo -n 執行，權限不足時立即失敗、不會卡在密碼提示。
 */
const config = require('../config');
const { ProxyNode } = require('../models');
const { NodeSession } = require('./sshSession');
const deployService = require('./deployService');

const GUARD_MS = 10 * 60000;
const lastReboot = new Map(); // nodeId -> timestamp

class RebootError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const SUDO_DENIED_RE = /password is required|a terminal is required|not allowed|not in the sudoers|may not run|authentication/i;

/** 回傳 { at, guardMinutes }；失敗丟 RebootError */
async function rebootNode(node) {
  if (!node.IsActive) throw new RebootError(400, '節點已停用，請先啟用再操作');
  if (deployService.isRunning()) throw new RebootError(409, '部署進行中，請等部署結束再重開機');
  const last = lastReboot.get(node.Id);
  if (last && Date.now() - last < GUARD_MS) {
    throw new RebootError(429, `此節點 ${Math.ceil((GUARD_MS - (Date.now() - last)) / 60000)} 分鐘前才送出重開機，請稍候`);
  }
  const others = (await ProxyNode.findAll({ where: { IsActive: true } })).filter((n) => n.Id !== node.Id);
  const notReady = others.filter((n) => n.HealthStatus !== 'ONLINE');
  if (notReady.length) {
    throw new RebootError(409, `其他節點 ${notReady.map((n) => `${n.NodeName}（${n.HealthStatus}）`).join('、')} 目前不正常，重開機會讓服務中斷；請等其他節點恢復 ONLINE 後再操作`);
  }

  const s = new NodeSession(node);
  try {
    await s.open({ sftp: false });
    let r;
    try {
      r = await s.exec(config.ssh.rebootCmd, 15000);
    } catch (e) {
      // 重開機時 SSH 連線可能直接被切斷或逾時，視為已送出
      r = { code: null, stdout: '', stderr: '', dropped: String(e.message || e) };
    }
    if (SUDO_DENIED_RE.test(r.stderr || '')) {
      throw new RebootError(403, `節點未授權 deployer 執行重開機（${String(r.stderr).trim().slice(0, 200)}）。請在節點 sudoers 加上：deployer ALL=(root) NOPASSWD: /usr/bin/systemctl reboot`);
    }
    if (r.code && r.code !== 0) {
      throw new RebootError(502, `重開機指令失敗（exit ${r.code}）：${String(r.stderr || r.stdout).trim().slice(0, 300)}`);
    }
  } catch (e) {
    if (e instanceof RebootError) throw e;
    throw new RebootError(502, `無法連線到節點：${String(e.message || e).slice(0, 300)}`);
  } finally {
    await s.close();
  }
  lastReboot.set(node.Id, Date.now());
  await node.update({ HealthMessage: `重開機中（${new Date().toLocaleString('zh-TW', { hour12: false })} 送出）` });
  return { at: new Date().toISOString(), guardMinutes: GUARD_MS / 60000 };
}

module.exports = { rebootNode, RebootError };
