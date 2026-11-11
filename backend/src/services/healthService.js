'use strict';
/**
 * 節點健康檢查：SSH 可連線且 nginx 為 active → ONLINE；SSH 通但 nginx 非 active → DEGRADED；SSH 失敗 → OFFLINE
 * 同一條 SSH 連線順便收集 CPU / RAM / 硬碟使用率（只讀 /proc 與 df，不需 sudo）。
 * 資源數據只保存在記憶體，後端重啟後於下一次檢查（HEALTH_INTERVAL_SEC）時重新取得。
 */
const config = require('../config');
const { ProxyNode } = require('../models');
const { NodeSession } = require('./sshSession');
const deployService = require('./deployService');

// CPU 取兩次 /proc/stat 相隔 1 秒計算使用率；df 檢查 / 與 nginx 暫存目錄所在分割區
const STATS_CMD = [
  'head -n1 /proc/stat',
  'sleep 1',
  'head -n1 /proc/stat',
  "grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo",
  'cat /proc/loadavg',
  'nproc',
  'df -Pk / 2>/dev/null | tail -n1',
].join('; ');

const stats = new Map(); // nodeId -> { cpu, mem, swap, disk, load, cores, at }

const pct = (used, total) => (total > 0 ? Math.round((used / total) * 1000) / 10 : null);

function parseStats(out) {
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
  const cpuLines = lines.filter((l) => /^cpu\s/.test(l)).map((l) => l.split(/\s+/).slice(1).map(Number));
  let cpu = null;
  if (cpuLines.length === 2) {
    const [a, b] = cpuLines;
    const idle = (v) => (v[3] || 0) + (v[4] || 0); // idle + iowait
    const sum = (v) => v.slice(0, 8).reduce((x, y) => x + (y || 0), 0);
    const dt = sum(b) - sum(a);
    cpu = dt > 0 ? pct(dt - (idle(b) - idle(a)), dt) : null;
  }
  const kv = {};
  lines.forEach((l) => { const m = l.match(/^(\w+):\s+(\d+)\s*kB/); if (m) kv[m[1]] = Number(m[2]) * 1024; });
  const mem = kv.MemTotal ? { total: kv.MemTotal, used: kv.MemTotal - (kv.MemAvailable || 0), percent: pct(kv.MemTotal - (kv.MemAvailable || 0), kv.MemTotal) } : null;
  const swap = kv.SwapTotal ? { total: kv.SwapTotal, used: kv.SwapTotal - (kv.SwapFree || 0), percent: pct(kv.SwapTotal - (kv.SwapFree || 0), kv.SwapTotal) } : null;
  const loadLine = lines.find((l) => /^\d+\.\d+\s+\d+\.\d+\s+\d+\.\d+\s/.test(l));
  const load = loadLine ? loadLine.split(/\s+/).slice(0, 3).map(Number) : null;
  const coresLine = lines.find((l) => /^\d+$/.test(l));
  const cores = coresLine ? Number(coresLine) : null;
  // df -Pk：Filesystem 1024-blocks Used Available Capacity Mounted
  const dfLine = lines.find((l) => /\s\/$/.test(l) && /\d+%/.test(l));
  let disk = null;
  if (dfLine) {
    const p = dfLine.split(/\s+/);
    const total = Number(p[1]) * 1024;
    const used = Number(p[2]) * 1024;
    const avail = Number(p[3]) * 1024;
    disk = { mount: '/', total, used, free: avail, percent: pct(used, used + avail) };
  }
  return { cpu, mem, swap, disk, load, cores };
}

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
    try {
      const st = await s.exec(STATS_CMD, 15000);
      stats.set(node.Id, { ...parseStats(st.stdout), at: new Date().toISOString() });
    } catch (e) {
      stats.set(node.Id, { error: `無法取得資源使用率：${String(e.message || e).slice(0, 200)}`, at: new Date().toISOString() });
    }
  } catch (e) {
    message = String(e.message || e).slice(0, 480);
    stats.delete(node.Id);
  } finally {
    await s.close();
  }
  await node.update({ HealthStatus: status, HealthMessage: message, LastHealthCheckAt: new Date() });
  return node;
}

/** 節點清單加上記憶體中的資源數據（Stats） */
const withStats = (nodes) => nodes.map((n) => ({ ...n.get({ plain: true }), Stats: stats.get(n.Id) || null }));

async function listNodes() {
  return withStats(await ProxyNode.findAll({ order: [['Id', 'ASC']] }));
}

async function checkAllNodes() {
  if (deployService.isRunning()) return listNodes(); // 部署中不干擾
  const nodes = await ProxyNode.findAll({ order: [['Id', 'ASC']] });
  nodes.filter((n) => !n.IsActive).forEach((n) => stats.delete(n.Id));
  await Promise.allSettled(nodes.filter((n) => n.IsActive).map(checkNode));
  return listNodes();
}

function startScheduler() {
  const sec = config.healthIntervalSec;
  if (!sec || sec <= 0) return;
  const tick = () => checkAllNodes().catch((e) => console.error('[health]', e.message));
  setTimeout(tick, 3000);
  setInterval(tick, sec * 1000).unref();
}

module.exports = { checkAllNodes, listNodes, startScheduler, parseStats };
