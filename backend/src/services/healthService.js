'use strict';
/**
 * 節點健康檢查：SSH 可連線且 nginx 為 active → ONLINE；SSH 通但 nginx 非 active → DEGRADED；SSH 失敗 → OFFLINE
 * 同一條 SSH 連線順便收集 CPU / RAM / 硬碟使用率（只讀 /proc 與 df，不需 sudo）。
 * 資源數據只保存在記憶體，後端重啟後於下一次檢查（HEALTH_INTERVAL_SEC）時重新取得。
 *
 * 同一條 SSH 連線也從節點測試所有啟用規則的後端（只測 TCP、平行、每台最多 BACKEND_TIMEOUT 秒），
 * 結果供規則清單「後端目標」的燈號使用；不送 HTTP 請求，後端不會因此多出存取紀錄。
 */
const config = require('../config');
const { ProxyNode, DomainRule, RuleUpstream } = require('../models');
const { NodeSession } = require('./sshSession');
const deployService = require('./deployService');
const backendProbe = require('./backendProbe');
const { WAF_CHECK_CMD, parseWafCheck } = require('./wafService');

const BACKEND_TIMEOUT = 3;
const MAX_BACKENDS = 300;
// 'host:port'（小寫）-> Map(nodeId -> { nodeName, status, ms, at })
const backendStatus = new Map();
let backendCheckedAt = null;
const bkey = (host, port) => `${String(host).toLowerCase()}:${port}`;

/** 所有啟用規則中、啟用中的後端（去重） */
async function loadBackendTargets() {
  const rules = await DomainRule.findAll({
    where: { IsActive: true }, attributes: ['Id'],
    include: [{ model: RuleUpstream, as: 'Upstreams', where: { IsActive: true }, required: false, attributes: ['Host', 'Port'] }],
  });
  const list = rules.flatMap((r) => (r.Upstreams || []).map((u) => ({ host: u.Host, port: u.Port })));
  return backendProbe.cleanTargets(list, MAX_BACKENDS);
}

// CPU 取兩次 /proc/stat 相隔 1 秒計算使用率；df 檢查 / 與 nginx 暫存目錄所在分割區
const STATS_CMD = [
  'head -n1 /proc/stat',
  'sleep 1',
  'head -n1 /proc/stat',
  "grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo",
  'cat /proc/loadavg',
  'nproc',
  'df -Pk / 2>/dev/null | tail -n1',
  WAF_CHECK_CMD, // WAF 模組是否已安裝（唯讀檢查檔案）
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
  return { cpu, mem, swap, disk, load, cores, waf: parseWafCheck(out) };
}

/** 記錄某節點對後端的測試結果；results 為 null 表示該節點這輪無法測試（清除舊結果，避免顯示過期燈號） */
function setBackendResults(node, results) {
  if (!results) {
    backendStatus.forEach((m) => m.delete(node.Id));
    return;
  }
  const at = new Date().toISOString();
  results.forEach((r) => {
    const k = bkey(r.host, r.port);
    if (!backendStatus.has(k)) backendStatus.set(k, new Map());
    backendStatus.get(k).set(node.Id, { nodeName: node.NodeName, status: r.status, ms: r.ms, at });
  });
}

async function checkNode(node, targets = []) {
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
    try {
      setBackendResults(node, await backendProbe.probeOnSession(s, targets, { timeout: BACKEND_TIMEOUT, tcpOnly: true }));
    } catch (e) {
      console.warn(`[health] ${node.NodeName} 後端檢測失敗：${e.message}`);
      setBackendResults(node, null);
    }
  } catch (e) {
    message = String(e.message || e).slice(0, 480);
    stats.delete(node.Id);
    setBackendResults(node, null);
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
  nodes.filter((n) => !n.IsActive).forEach((n) => { stats.delete(n.Id); setBackendResults(n, null); });
  let targets = [];
  try {
    targets = await loadBackendTargets();
  } catch (e) {
    console.warn(`[health] 無法載入後端清單：${e.message}`);
  }
  // 移除已不在任何啟用規則中的後端
  const keep = new Set(targets.map((t) => bkey(t.host, t.port)));
  [...backendStatus.keys()].forEach((k) => { if (!keep.has(k)) backendStatus.delete(k); });
  // 已刪除的節點
  const ids = new Set(nodes.map((n) => n.Id));
  backendStatus.forEach((m) => [...m.keys()].forEach((id) => { if (!ids.has(id)) m.delete(id); }));

  await Promise.allSettled(nodes.filter((n) => n.IsActive).map((n) => checkNode(n, targets)));
  backendCheckedAt = new Date().toISOString();
  return listNodes();
}

/**
 * 後端連線狀態（給規則清單燈號用）
 * @returns {{ checkedAt: string|null, intervalSec: number, backends: Object<string, Array<{nodeId,nodeName,status,ms,at}>> }}
 */
function getBackendStatus() {
  const backends = {};
  backendStatus.forEach((m, k) => {
    backends[k] = [...m.entries()].map(([nodeId, v]) => ({ nodeId, ...v }));
  });
  return { checkedAt: backendCheckedAt, intervalSec: config.healthIntervalSec, backends };
}

function startScheduler() {
  const sec = config.healthIntervalSec;
  if (!sec || sec <= 0) return;
  const tick = () => checkAllNodes().catch((e) => console.error('[health]', e.message));
  setTimeout(tick, 3000);
  setInterval(tick, sec * 1000).unref();
}

module.exports = { checkAllNodes, listNodes, startScheduler, parseStats, getBackendStatus };
