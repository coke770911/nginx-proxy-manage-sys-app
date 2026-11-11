'use strict';
/**
 * 從 Nginx 節點測試後端主機連線
 * - 以 SSH 在節點上執行 bash /dev/tcp 測 TCP 連線，連得上再用 curl 取 HTTP 狀態碼（僅供參考）
 * - 所有後端在同一條指令中平行測試，每台最多等 PROBE_TIMEOUT 秒
 * - Host / Port 先經 nginxTemplate 相同的白名單驗證，才組進 shell 指令，避免指令注入
 */
const { NodeSession } = require('./sshSession');

const HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,253}[A-Za-z0-9])?$/;
const PROBE_TIMEOUT = 5;
const MAX_TARGETS = 64;

/** 清理並去除重複的測試目標 [{ host, port }] */
function cleanTargets(list) {
  const seen = new Set();
  const out = [];
  (list || []).forEach((t) => {
    const host = String(t.host ?? t.Host ?? '').trim();
    const port = Number(t.port ?? t.Port);
    if (!HOST_RE.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) return;
    const key = `${host.toLowerCase()}:${port}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ host, port });
  });
  if (out.length > MAX_TARGETS) throw new Error(`一次最多測試 ${MAX_TARGETS} 台後端`);
  return out;
}

/** 組出在節點上執行的指令：每個目標一個背景子程序，輸出一行 R|host|port|結果|毫秒|HTTP 碼 */
function buildScript(targets) {
  const T = PROBE_TIMEOUT;
  const one = ({ host, port }) => [
    '(',
    's=$(date +%s%N);',
    `timeout ${T} bash -c '</dev/tcp/${host}/${port}' 2>/dev/null; rc=$?;`,
    'e=$(date +%s%N);',
    'if [ $rc -eq 0 ]; then',
    `  c=$(curl -s -o /dev/null -m ${T} -w '%{http_code}' 'http://${host}:${port}/' 2>/dev/null); [ -n "$c" ] || c=000;`,
    `  echo "R|${host}|${port}|OK|$(( (e-s)/1000000 ))|$c";`,
    `elif [ $rc -eq 124 ]; then echo "R|${host}|${port}|TIMEOUT|$(( (e-s)/1000000 ))|";`,
    `else echo "R|${host}|${port}|REFUSED|$(( (e-s)/1000000 ))|"; fi`,
    ') &',
  ].join(' ');
  return `${targets.map(one).join('\n')}\nwait`;
}

const REASON = {
  OK: '連線成功',
  TIMEOUT: `逾時（${PROBE_TIMEOUT} 秒內無回應，可能被防火牆擋住或主機未開機）`,
  REFUSED: '拒絕連線或無法解析（該 Port 沒有服務在監聽，或主機名稱解析失敗）',
};

function parse(out, targets) {
  const map = new Map();
  out.split('\n').forEach((l) => {
    const m = l.trim().match(/^R\|([^|]+)\|(\d+)\|(OK|TIMEOUT|REFUSED)\|(\d*)\|(\d*)$/);
    if (m) map.set(`${m[1].toLowerCase()}:${m[2]}`, { status: m[3], ms: Number(m[4] || 0), http: m[5] && m[5] !== '000' ? Number(m[5]) : null });
  });
  return targets.map((t) => {
    const r = map.get(`${t.host.toLowerCase()}:${t.port}`) || { status: 'ERROR', ms: null, http: null };
    return { ...t, ok: r.status === 'OK', status: r.status, ms: r.ms, http: r.http, message: REASON[r.status] || '節點未回傳結果' };
  });
}

/** 在一個已開啟的 NodeSession 上測試 */
async function probeOnSession(session, targets) {
  if (!targets.length) return [];
  const r = await session.exec(buildScript(targets), (PROBE_TIMEOUT * 2 + 10) * 1000);
  return parse(r.stdout, targets);
}

/**
 * 從多個節點測試多個後端
 * @returns {Promise<Array<{nodeId,nodeName,ip,error?:string,results:Array}>>}
 */
async function probeFromNodes(nodes, rawTargets) {
  const targets = cleanTargets(rawTargets);
  return Promise.all(nodes.map(async (n) => {
    const s = new NodeSession(n);
    const base = { nodeId: n.Id, nodeName: n.NodeName, ip: n.IpAddress };
    try {
      await s.open({ sftp: false });
      return { ...base, results: await probeOnSession(s, targets) };
    } catch (e) {
      return { ...base, error: `無法連線到節點：${String(e.message || e).slice(0, 300)}`, results: [] };
    } finally {
      await s.close();
    }
  }));
}

module.exports = { probeFromNodes, probeOnSession, cleanTargets, PROBE_TIMEOUT };
