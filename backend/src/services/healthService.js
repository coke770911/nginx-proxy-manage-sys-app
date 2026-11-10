'use strict';
/** 節點健康檢查：SSH 可連線且 nginx 為 active → ONLINE；SSH 通但 nginx 非 active → DEGRADED；SSH 失敗 → OFFLINE */
const config = require('../config');
const { ProxyNode } = require('../models');
const { NodeSession } = require('./sshSession');
const deployService = require('./deployService');

async function checkNode(node) {
  const s = new NodeSession(node);
  let status = 'OFFLINE';
  let message = '';
  try {
    await s.open({ sftp: false });
    const r = await s.exec('systemctl is-active nginx', 10000);
    const state = r.stdout.trim() || r.stderr.trim();
    status = state === 'active' ? 'ONLINE' : 'DEGRADED';
    message = `nginx: ${state || 'unknown'}`;
  } catch (e) {
    message = String(e.message || e).slice(0, 480);
  } finally {
    await s.close();
  }
  await node.update({ HealthStatus: status, HealthMessage: message, LastHealthCheckAt: new Date() });
  return node;
}

async function checkAllNodes() {
  if (deployService.isRunning()) return ProxyNode.findAll({ order: [['Id', 'ASC']] }); // 部署中不干擾
  const nodes = await ProxyNode.findAll({ order: [['Id', 'ASC']] });
  await Promise.allSettled(nodes.filter((n) => n.IsActive).map(checkNode));
  return ProxyNode.findAll({ order: [['Id', 'ASC']] });
}

function startScheduler() {
  const sec = config.healthIntervalSec;
  if (!sec || sec <= 0) return;
  const tick = () => checkAllNodes().catch((e) => console.error('[health]', e.message));
  setTimeout(tick, 3000);
  setInterval(tick, sec * 1000).unref();
}

module.exports = { checkAllNodes, startScheduler };
