'use strict';
/**
 * 雙機兩階段安全部署引擎 (Two-Phase Atomic Deployment via SSH)
 *
 *  階段 0  平行連線所有啟用節點（任一失敗 → 中止，尚未變更任何節點）
 *  階段 1  平行：備份遠端 sites-managed/ssl → /tmp/nginx_backup.tar.gz，再寫入憑證與 .conf
 *  階段 2  平行：sudo nginx -t
 *            任一失敗 → 所有節點自動回滾（解壓備份）、中斷、stderr 原文寫入 DeployLogs 並回傳前端
 *  階段 3  全數通過 → 平行：sudo systemctl reload nginx，更新 LastSyncAt
 *
 * 即時日誌：每行日誌同時 emit 到 bus（SSE 端點訂閱），並彙整寫入 DeployLogs.LogText。
 * 備註：備份範圍為 sites-managed 與 ssl 兩個目錄（憑證若同編號被續約覆蓋，回滾時才能還原成舊憑證）。
 */
const EventEmitter = require('events');
const config = require('../config');
const { ProxyNode, DomainRule, RuleUpstream, SslCertificate, DeployLog } = require('../models');
const { NodeSession } = require('./sshSession');
const { validateRule, renderConf, renderDefaultConf, DEFAULT_CONF_NAME, confFileName, certRemotePaths, upstreamsOf } = require('./nginxTemplate');
const backendProbe = require('./backendProbe');

const bus = new EventEmitter();
bus.setMaxListeners(100);
let running = false;

class DeployBusyError extends Error {
  constructor() {
    super('已有部署作業進行中，請等待完成後再試。');
    this.status = 409;
  }
}

/** 流程性失敗：帶 deployStatus / detail 供最終紀錄使用 */
class DeployError extends Error {
  constructor(message, { status = 'FAILED', detail } = {}) {
    super(message);
    this.deployStatus = status;
    this.detail = detail || message;
  }
}

const rel = (p) => p.replace(/^\/+/, '');
const errText = (e) => (e && e.message ? e.message : String(e));

/** 伺服器當地時間，格式 YYYY/MM/DD HH:mm:ss（寫入部署紀錄用） */
const pad2 = (n) => String(n).padStart(2, '0');
const localStamp = (d) => `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;

function makeLogger(lines) {
  return (level, msg, node) => {
    const now = new Date();
    // SSE 傳 ISO（前端依瀏覽器時區顯示）；存入資料庫的文字改用當地時間
    const entry = { ts: now.toISOString(), level, node: node || null, msg };
    lines.push(`${localStamp(now)} [${level.toUpperCase()}]${node ? ` [${node}]` : ''} ${msg}`);
    bus.emit('log', entry);
  };
}

/** 對所有節點平行執行 fn，逐節點記錄結果；不丟例外，回傳 [{session, ok, error}] */
async function forAll(sessions, step, fn, ctx) {
  const settled = await Promise.allSettled(
    sessions.map(async (s) => {
      const r = ctx.results[s.node.Id];
      try {
        const v = await fn(s);
        r.steps[step] = 'ok';
        ctx.log('ok', `${step} ✔`, s.name);
        return v;
      } catch (e) {
        r.steps[step] = 'fail';
        r.error = errText(e);
        ctx.log('error', `${step} ✘ ${errText(e)}`, s.name);
        if (e.raw) e.raw.split('\n').forEach((l) => l.trim() && ctx.log('error', `  ${l}`, s.name));
        throw e;
      }
    }),
  );
  return settled.map((x, i) => ({ session: sessions[i], ok: x.status === 'fulfilled', error: x.reason }));
}

/* ------------------------------------------------------------------ 檔案集合 */
async function buildFileSet(log) {
  const rules = await DomainRule.findAll({
    where: { IsActive: true },
    include: [{ model: SslCertificate, as: 'certificate' }, { model: RuleUpstream, as: 'Upstreams' }],
    order: [['DomainName', 'ASC'], [{ model: RuleUpstream, as: 'Upstreams' }, 'SortOrder', 'ASC'], [{ model: RuleUpstream, as: 'Upstreams' }, 'Id', 'ASC']],
  });
  const confs = new Map(); // fileName → content
  const certs = new Map(); // certId → { crt, key }
  const problems = [];
  const backends = new Map(); // host:port → { host, port, domains[] }（維護中的規則不轉發，不需檢查）
  let defaultCert = null; // 預設站台 443 使用的憑證
  for (const r of rules) {
    const p = r.get({ plain: true });
    const errs = validateRule(p);
    if (!p.certificate) errs.push('找不到綁定的憑證');
    if (errs.length) {
      problems.push(`${p.DomainName}：${errs.join('；')}`);
      continue;
    }
    if (new Date(p.certificate.ValidTo) < new Date()) log('warn', `規則 ${p.DomainName} 綁定的憑證「${p.certificate.Alias}」已過期`);
    confs.set(confFileName(p.DomainName), renderConf(p));
    if (!p.IsMaintenance) {
      upstreamsOf(p).filter((u) => u.IsActive !== false).forEach((u) => {
        const key = `${String(u.Host).toLowerCase()}:${u.Port}`;
        if (!backends.has(key)) backends.set(key, { host: u.Host, port: u.Port, domains: [] });
        backends.get(key).domains.push(p.DomainName);
      });
    }
    certs.set(p.certificate.Id, { crt: p.certificate.CertPem, key: p.certificate.KeyPem });
    if (!defaultCert || new Date(p.certificate.ValidTo) > new Date(defaultCert.ValidTo)) defaultCert = p.certificate;
  }
  if (problems.length) throw new DeployError('部分規則驗證失敗，已中止部署（未變更任何節點）', { detail: problems.join('\n') });
  if (!confs.size) log('warn', '目前沒有任何啟用的規則，部署後遠端只保留預設站台（404 頁面）');
  // 預設站台的 443 借用一張已部署、到期日最晚的憑證（以 IP 連線本來就會出現憑證名稱不符的警告）
  if (defaultCert) log('info', `預設站台（404 頁面）使用憑證「${defaultCert.Alias}」`);
  confs.set(DEFAULT_CONF_NAME, renderDefaultConf(defaultCert ? defaultCert.Id : null));
  log('info', `已產生 ${confs.size} 個設定檔、${certs.size} 張憑證`);
  return { confs, certs, backends, ruleCount: rules.length };
}

/* ------------------------------------------------------------------ 階段 1 */
async function putAtomic(sftp, remote, content, mode) {
  const tmp = `${remote}.tmp`; // *.tmp 不會被 nginx 的 *.conf include 到
  await sftp.put(Buffer.from(content, 'utf8'), tmp);
  await sftp.chmod(tmp, mode);
  await sftp.posixRename(tmp, remote);
}

async function phaseBackupAndWrite(s, fileSet, log) {
  const { confDir, sslDir, backupPath } = config.ssh;

  const bk = await s.exec(`mkdir -p ${confDir} ${sslDir} && (umask 077; tar -czf ${backupPath} -C / ${rel(confDir)} ${rel(sslDir)})`);
  if (bk.code !== 0) throw new Error(`備份失敗：${bk.stderr.trim() || `exit ${bk.code}`}`);
  s.backedUp = true;
  log('info', `已備份至 ${backupPath}`, s.name);

  // 先寫憑證，再寫 conf（conf 不會引用到尚未存在的憑證）
  const wantedSsl = new Set();
  for (const [id, c] of fileSet.certs) {
    const { crt, key } = certRemotePaths(id);
    await putAtomic(s.sftp, crt, c.crt, 0o644);
    await putAtomic(s.sftp, key, c.key, 0o600);
    wantedSsl.add(crt.split('/').pop());
    wantedSsl.add(key.split('/').pop());
  }
  for (const [name, content] of fileSet.confs) {
    await putAtomic(s.sftp, `${confDir}/${name}`, content, 0o644);
  }
  log('info', `已寫入 ${fileSet.certs.size} 張憑證、${fileSet.confs.size} 個設定檔`, s.name);

  // 清除不再需要的檔案（停用/刪除的規則、孤兒憑證、殘留 .tmp）
  let removed = 0;
  for (const f of await s.sftp.list(confDir)) {
    if (f.type === '-' && !fileSet.confs.has(f.name)) {
      await s.sftp.delete(`${confDir}/${f.name}`);
      removed += 1;
    }
  }
  for (const f of await s.sftp.list(sslDir)) {
    if (f.type === '-' && /^cert_\d+\.(crt|key)(\.tmp)?$/.test(f.name) && !wantedSsl.has(f.name)) {
      await s.sftp.delete(`${sslDir}/${f.name}`);
      removed += 1;
    }
  }
  if (removed) log('info', `已清除 ${removed} 個過時檔案`, s.name);
}

/* ------------------------------------------------------------------ 階段 2 */
async function phaseNginxTest(s, log) {
  const r = await s.exec(config.ssh.testCmd);
  const out = `${r.stdout}${r.stderr}`.trim(); // nginx 把結果輸出到 stderr（成功時也是）
  if (r.code !== 0) {
    const e = new Error(`nginx -t 未通過（exit ${r.code}）`);
    e.raw = r.stderr.trim() || out;
    throw e;
  }
  out.split('\n').forEach((l) => l.trim() && log('info', l, s.name));
}

/* ------------------------------------------------------------------ 回滾 */
async function rollbackAll(targets, ctx) {
  if (!targets.length) return true;
  ctx.log('warn', `【回滾】還原 ${targets.length} 個節點至部署前狀態`);
  const { confDir, sslDir, backupPath } = config.ssh;
  // 先驗證備份可讀取，才清空目錄，避免「刪了卻還原不了」
  const cmd = `set -e; tar -tzf ${backupPath} >/dev/null; find ${confDir} -mindepth 1 -delete; find ${sslDir} -mindepth 1 -delete; tar -xzf ${backupPath} -C /`;
  const res = await forAll(targets, '回滾', async (s) => {
    const r = await s.exec(cmd);
    if (r.code !== 0) throw new Error(r.stderr.trim() || `exit ${r.code}`);
  }, ctx);
  return res.every((x) => x.ok);
}

/* ------------------------------------------------------------------ 主流程 */
async function deploy({ triggeredBy = 'admin', triggerIp = null } = {}) {
  if (running) throw new DeployBusyError();
  running = true;

  const lines = [];
  const log = makeLogger(lines);
  const results = {};
  const ctx = { log, results };
  const sessions = [];
  let status = 'FAILED';
  let message = '';
  let errorDetail = null;
  let ruleCount = null;

  const record = await DeployLog.create({ TriggeredBy: triggeredBy, TriggerIp: triggerIp, Status: 'RUNNING', StartedAt: new Date() });

  try {
    log('info', `部署開始（紀錄 #${record.Id}），操作者：${triggeredBy}`);

    const nodes = await ProxyNode.findAll({ where: { IsActive: true }, order: [['Id', 'ASC']] });
    if (!nodes.length) throw new DeployError('沒有任何啟用的 Nginx 節點');
    nodes.forEach((n) => {
      results[n.Id] = { nodeId: n.Id, name: n.NodeName, ip: n.IpAddress, steps: {}, error: null };
      sessions.push(new NodeSession(n));
    });

    const fileSet = await buildFileSet(log);
    ruleCount = fileSet.ruleCount;

    // ---- 階段 0：連線
    log('info', `【階段 0】連線 ${sessions.length} 個節點`);
    const conn = await forAll(sessions, '連線', (s) => s.open(), ctx);
    const connFail = conn.filter((x) => !x.ok);
    if (connFail.length) {
      throw new DeployError('節點連線失敗，已中止部署（未變更任何節點）', {
        detail: connFail.map((x) => `[${x.session.name}] ${errText(x.error)}`).join('\n'),
      });
    }

    // ---- 後端連線檢查：只提出警告，不阻擋部署（後端可能刻意尚未上線）
    if (fileSet.backends.size) {
      log('info', `檢查 ${fileSet.backends.size} 個後端的連線（每個最多 ${backendProbe.PROBE_TIMEOUT} 秒）`);
      const targets = [...fileSet.backends.values()];
      await Promise.all(sessions.map(async (s) => {
        try {
          const rs = await backendProbe.probeOnSession(s, targets);
          const bad = rs.filter((x) => !x.ok);
          if (!bad.length) log('ok', `後端連線全部正常（${rs.length} 個）`, s.name);
          bad.forEach((x) => {
            const b = fileSet.backends.get(`${x.host.toLowerCase()}:${x.port}`);
            log('warn', `後端 ${x.host}:${x.port} 連不上：${x.message}；影響網域：${(b?.domains || []).join(', ')}（部署照常進行，使用者連線會得到 502/504）`, s.name);
          });
        } catch (e) {
          log('warn', `後端連線檢查失敗（不影響部署）：${errText(e)}`, s.name);
        }
      }));
    }

    // ---- 階段 1：備份 + 寫入
    log('info', '【階段 1】備份並寫入憑證/設定檔');
    const p1 = await forAll(sessions, '備份與寫入', (s) => phaseBackupAndWrite(s, fileSet, log), ctx);
    const p1Fail = p1.filter((x) => !x.ok);
    if (p1Fail.length) {
      const detail = p1Fail.map((x) => `[${x.session.name}] ${errText(x.error)}`).join('\n');
      const rbOk = await rollbackAll(sessions.filter((s) => s.backedUp), ctx);
      throw new DeployError(rbOk ? '寫入階段失敗，已自動回滾' : '寫入階段失敗且【回滾失敗】，請立即人工檢查節點！', {
        status: rbOk ? 'ROLLED_BACK' : 'FAILED',
        detail,
      });
    }

    // ---- 階段 2：語法預檢
    log('info', '【階段 2】nginx -t 語法預檢');
    const p2 = await forAll(sessions, 'nginx -t', (s) => phaseNginxTest(s, log), ctx);
    const p2Fail = p2.filter((x) => !x.ok);
    if (p2Fail.length) {
      const detail = p2Fail.map((x) => `[${x.session.name}] ${x.error.raw || errText(x.error)}`).join('\n\n');
      const rbOk = await rollbackAll(sessions, ctx);
      throw new DeployError(rbOk ? 'nginx -t 預檢失敗，已自動回滾並中斷部署' : 'nginx -t 預檢失敗且【回滾失敗】，請立即人工檢查節點！', {
        status: rbOk ? 'ROLLED_BACK' : 'FAILED',
        detail,
      });
    }

    // ---- 階段 3：Reload
    log('info', '【階段 3】所有節點語法通過，執行 reload');
    const p3 = await forAll(sessions, 'reload', async (s) => {
      const r = await s.exec(config.ssh.reloadCmd);
      if (r.code !== 0) throw new Error(`reload 失敗（exit ${r.code}）：${r.stderr.trim()}`);
      await s.node.update({ LastSyncAt: new Date() });
    }, ctx);
    const p3Fail = p3.filter((x) => !x.ok);
    if (p3Fail.length) {
      status = 'PARTIAL';
      message = '部分節點 reload 失敗（設定已通過語法檢查），請至失敗節點手動處理';
      errorDetail = p3Fail.map((x) => `[${x.session.name}] ${errText(x.error)}`).join('\n');
    } else {
      status = 'SUCCESS';
      message = `部署成功：${sessions.length} 個節點已同步並 reload`;
    }
  } catch (e) {
    status = e.deployStatus || 'FAILED';
    message = e instanceof DeployError ? e.message : `部署過程發生未預期錯誤：${errText(e)}`;
    errorDetail = e.detail || errText(e);
  } finally {
    log(status === 'SUCCESS' ? 'ok' : 'error', `部署結束：${status} — ${message}`);
    await Promise.allSettled(sessions.map((s) => s.close()));
    try {
      await record.update({
        Status: status,
        FinishedAt: new Date(),
        RuleCount: ruleCount,
        ErrorDetail: errorDetail,
        NodeResults: JSON.stringify(Object.values(results)),
        LogText: lines.join('\n'),
      });
    } catch (dbErr) {
      console.error('寫入 DeployLogs 失敗：', dbErr);
    }
    running = false;
  }

  return { ok: status === 'SUCCESS', logId: String(record.Id), status, message, errorDetail, nodeResults: Object.values(results) };
}

module.exports = { deploy, bus, isRunning: () => running, DeployBusyError };
