'use strict';
const express = require('express');
const multer = require('multer');
const { fn, col } = require('sequelize');
const { Op } = require('sequelize');
const { sequelize, ProxyNode, SslCertificate, DomainRule, RuleUpstream, DeployLog, AuditLog } = require('../models');
const audit = require('../services/auditService');
const certService = require('../services/certService');
const { validateRule, renderConf } = require('../services/nginxTemplate');
const deployService = require('../services/deployService');
const healthService = require('../services/healthService');
const { fetchHostFingerprint } = require('../services/sshSession');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 3 } });
const certUpload = upload.fields([{ name: 'cert', maxCount: 1 }, { name: 'key', maxCount: 1 }, { name: 'pfx', maxCount: 1 }]);

const wrap = (fnc) => (req, res, next) => Promise.resolve(fnc(req, res, next)).catch(next);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const pick = (src, keys) => keys.reduce((o, k) => (src[k] !== undefined ? { ...o, [k]: src[k] } : o), {});
const toBool = (v) => v === true || v === 1 || v === '1' || v === 'true';
const NO_PEM = { exclude: ['CertPem', 'KeyPem'] };

/* =============================================================== 節點 ProxyNodes */
const NODE_FIELDS = ['NodeName', 'IpAddress', 'SshPort', 'SshUser', 'SshKeyPath', 'HostKeySha256', 'IsActive'];
const HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,253}[A-Za-z0-9])?$/;

const FP_RE = /^SHA256:[A-Za-z0-9+/]{43}=?$/;

/** 清理節點欄位：去空白、空字串轉 null */
function cleanNode(data) {
  for (const k of ['NodeName', 'IpAddress', 'SshUser', 'SshKeyPath', 'HostKeySha256']) {
    if (typeof data[k] === 'string') data[k] = data[k].trim();
  }
  if (data.SshKeyPath === '') data.SshKeyPath = null;
  if (data.HostKeySha256 === '') data.HostKeySha256 = null;
  if (data.SshPort !== undefined) data.SshPort = Number(data.SshPort);
  return data;
}

function checkNode(n) {
  if (!n.NodeName) throw new HttpError(400, '節點名稱必填');
  if (n.NodeName.length > 100) throw new HttpError(400, '節點名稱最多 100 字');
  if (n.SshKeyPath && (n.SshKeyPath.length > 260 || /[\0\r\n]/.test(n.SshKeyPath))) throw new HttpError(400, '私鑰路徑格式不正確');
  if (n.HostKeySha256 && !FP_RE.test(n.HostKeySha256)) throw new HttpError(400, '主機金鑰指紋格式應為 SHA256:xxxx（43 字元 Base64）');
  if (!HOST_RE.test(n.IpAddress || '')) throw new HttpError(400, '節點 IP/主機名稱格式不正確');
  const port = Number(n.SshPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, 'SSH Port 必須為 1–65535');
  if (!/^[a-z_][a-z0-9_-]{0,31}$/i.test(n.SshUser || '')) throw new HttpError(400, 'SSH 帳號格式不正確');
}

const nodeName = (n) => `${n.NodeName} (${n.IpAddress})`;

router.get('/nodes', wrap(async (req, res) => {
  res.json(await healthService.listNodes());
}));

router.post('/nodes/check', wrap(async (req, res) => {
  res.json(await healthService.checkAllNodes());
}));

router.post('/nodes/fingerprint', wrap(async (req, res) => {
  const host = String(req.body?.IpAddress || '').trim();
  const port = Number(req.body?.SshPort || 22);
  if (!HOST_RE.test(host)) throw new HttpError(400, '節點 IP/主機名稱格式不正確');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, 'SSH Port 必須為 1–65535');
  try {
    res.json({ fingerprint: await fetchHostFingerprint(host, port) });
  } catch (e) {
    throw new HttpError(502, `無法讀取 ${host}:${port} 的主機金鑰：${e.message}`);
  }
}));

router.post('/nodes', wrap(async (req, res) => {
  const data = cleanNode(pick(req.body, NODE_FIELDS));
  if ('IsActive' in data) data.IsActive = toBool(data.IsActive);
  checkNode({ SshPort: 22, SshUser: 'deployer', ...data });
  const node = await ProxyNode.create(data);
  await audit.record(req, { action: 'CREATE', targetType: 'NODE', targetId: node.Id, targetName: nodeName(node), detail: audit.snapshot(data) });
  res.status(201).json(node);
}));

router.put('/nodes/:id', wrap(async (req, res) => {
  const node = await ProxyNode.findByPk(req.params.id);
  if (!node) throw new HttpError(404, '節點不存在');
  const data = cleanNode(pick(req.body, NODE_FIELDS));
  if ('IsActive' in data) data.IsActive = toBool(data.IsActive);
  const before = { ...node.get({ plain: true }) };
  checkNode({ ...before, ...data });
  await node.update(data);
  await audit.record(req, { action: 'UPDATE', targetType: 'NODE', targetId: node.Id, targetName: nodeName(node), detail: audit.diff(before, data) });
  res.json(node);
}));

router.delete('/nodes/:id', wrap(async (req, res) => {
  const node = await ProxyNode.findByPk(req.params.id);
  if (!node) throw new HttpError(404, '節點不存在');
  await node.destroy();
  await audit.record(req, { action: 'DELETE', targetType: 'NODE', targetId: node.Id, targetName: nodeName(node), detail: audit.snapshot(node.get({ plain: true }), NODE_FIELDS) });
  res.json({ ok: true });
}));

/* =============================================================== 憑證 SslCertificates */
const certMeta = (b) => ({
  SanDomains: b.sanDomains,
  CertPem: b.certPem,
  KeyPem: b.keyPem,
  Issuer: b.issuer,
  Subject: b.subject,
  Fingerprint: b.fingerprint,
  ValidFrom: b.validFrom,
  ValidTo: b.validTo,
});

const certInfo = (c) => ({ Alias: c.Alias, SanDomains: c.SanDomains, Issuer: c.Issuer, Fingerprint: c.Fingerprint, ValidTo: c.ValidTo });

router.get('/certificates', wrap(async (req, res) => {
  const [certs, counts] = await Promise.all([
    SslCertificate.findAll({ attributes: NO_PEM, order: [['ValidTo', 'ASC']] }),
    DomainRule.findAll({ attributes: ['CertificateId', [fn('COUNT', col('Id')), 'cnt']], group: ['CertificateId'], raw: true }),
  ]);
  const m = new Map(counts.map((c) => [c.CertificateId, Number(c.cnt)]));
  res.json(certs.map((c) => ({ ...c.get({ plain: true }), RuleCount: m.get(c.Id) || 0 })));
}));

router.post('/certificates', certUpload, wrap(async (req, res) => {
  const alias = String(req.body.alias || '').trim();
  if (!alias) throw new HttpError(400, '請輸入憑證別名');
  const bundle = await certService.importFromUpload({ mode: req.body.mode, files: req.files, pfxPassword: req.body.pfxPassword });
  if (await SslCertificate.findOne({ where: { Fingerprint: bundle.fingerprint } })) {
    throw new HttpError(409, '此憑證（相同指紋）已存在於憑證庫；若為續約請使用「更新憑證」。');
  }
  const row = await SslCertificate.create({ Alias: alias, ...certMeta(bundle) });
  await audit.record(req, { action: 'CREATE', targetType: 'CERT', targetId: row.Id, targetName: row.Alias, detail: audit.snapshot(certInfo(row)) });
  res.status(201).json({ ...row.get({ plain: true }), CertPem: undefined, KeyPem: undefined, warnings: bundle.warnings });
}));

/** 憑證續約：沿用同一筆憑證 ID，所有綁定的規則不需改動 */
router.put('/certificates/:id', certUpload, wrap(async (req, res) => {
  const cert = await SslCertificate.findByPk(req.params.id);
  if (!cert) throw new HttpError(404, '憑證不存在');
  const bundle = await certService.importFromUpload({ mode: req.body.mode, files: req.files, pfxPassword: req.body.pfxPassword });
  const bound = await DomainRule.findAll({ where: { CertificateId: cert.Id }, attributes: ['DomainName'] });
  const uncovered = bound.filter((r) => !certService.certCoversDomain(bundle.sanDomains, r.DomainName)).map((r) => r.DomainName);
  if (uncovered.length) throw new HttpError(400, `新憑證未涵蓋已綁定的網域：${uncovered.join(', ')}`);
  const alias = String(req.body.alias || '').trim();
  const before = certInfo(cert);
  await cert.update({ ...(alias ? { Alias: alias } : {}), ...certMeta(bundle) });
  await audit.record(req, { action: 'RENEW', targetType: 'CERT', targetId: cert.Id, targetName: cert.Alias, detail: audit.diff(before, certInfo(cert)) });
  res.json({ ...cert.get({ plain: true }), CertPem: undefined, KeyPem: undefined, warnings: bundle.warnings });
}));

router.delete('/certificates/:id', wrap(async (req, res) => {
  const used = await DomainRule.count({ where: { CertificateId: req.params.id } });
  if (used) throw new HttpError(409, `此憑證仍被 ${used} 條網域規則使用，請先解除綁定`);
  const cert = await SslCertificate.findByPk(req.params.id, { attributes: NO_PEM });
  if (!cert) throw new HttpError(404, '憑證不存在');
  await cert.destroy();
  await audit.record(req, { action: 'DELETE', targetType: 'CERT', targetId: cert.Id, targetName: cert.Alias, detail: audit.snapshot(certInfo(cert)) });
  res.json({ ok: true });
}));

/* =============================================================== 網域規則 DomainRules */
const RULE_FIELDS = [
  'DomainName', 'CertificateId', 'ForceHttps', 'EnableWebSocket',
  'ClientMaxBodySize', 'IsActive', 'IsMaintenance', 'CustomNginxSnippet', 'Remark', 'LbMethod', 'LbCookieName',
];
const RULE_BOOLS = ['ForceHttps', 'EnableWebSocket', 'IsActive', 'IsMaintenance'];
const UP_ORDER = [[{ model: RuleUpstream, as: 'Upstreams' }, 'SortOrder', 'ASC'], [{ model: RuleUpstream, as: 'Upstreams' }, 'Id', 'ASC']];
const withUpstreams = { model: RuleUpstream, as: 'Upstreams', attributes: ['Id', 'Host', 'Port', 'Weight', 'IsBackup', 'IsActive', 'SortOrder'] };

async function checkRule(plain) {
  const errs = validateRule(plain);
  if (errs.length) throw new HttpError(400, errs.join('；'));
  const cert = await SslCertificate.findByPk(plain.CertificateId, { attributes: NO_PEM });
  if (!cert) throw new HttpError(400, '所選憑證不存在');
  if (!certService.certCoversDomain(cert.SanDomains, plain.DomainName)) {
    throw new HttpError(400, `憑證「${cert.Alias}」的涵蓋網域（${cert.SanDomains}）不包含 ${plain.DomainName}`);
  }
}

function normalizeRule(data) {
  const out = { ...data };
  RULE_BOOLS.forEach((k) => { if (k in out) out[k] = toBool(out[k]); });
  if ('DomainName' in out) out.DomainName = String(out.DomainName).trim().toLowerCase();
  if ('ClientMaxBodySize' in out) out.ClientMaxBodySize = String(out.ClientMaxBodySize).trim();
  if ('LbMethod' in out) out.LbMethod = String(out.LbMethod || 'round_robin').trim();
  if ('LbCookieName' in out) out.LbCookieName = String(out.LbCookieName || '').trim() || null;
  if (out.LbMethod && out.LbMethod !== 'cookie') out.LbCookieName = null;
  return out;
}

/** 前端送來的後端清單 → 乾淨陣列；未提供時回 undefined（代表不變更） */
function normalizeUpstreams(body) {
  if (body.Upstreams === undefined) {
    // 相容舊版 API：只送 TargetIp / TargetPort 時視為唯一一台後端
    if (body.TargetIp !== undefined) return [{ Host: String(body.TargetIp).trim(), Port: Number(body.TargetPort || 80), Weight: 1, IsBackup: false, IsActive: true }];
    return undefined;
  }
  if (!Array.isArray(body.Upstreams)) throw new HttpError(400, '後端主機清單格式不正確');
  if (!body.Upstreams.length) throw new HttpError(400, '至少要設定一台後端主機');
  return body.Upstreams.map((u, i) => ({
    Host: String(u?.Host || '').trim(),
    Port: Number(u?.Port),
    Weight: u?.Weight === undefined || u?.Weight === '' ? 1 : Number(u.Weight),
    IsBackup: toBool(u?.IsBackup),
    IsActive: u?.IsActive === undefined ? true : toBool(u.IsActive),
    SortOrder: i,
  }));
}

/** TargetIp / TargetPort 保留為第一台啟用中的主要後端（列表顯示、相容舊版） */
function primaryOf(ups) {
  const p = ups.find((u) => u.IsActive && !u.IsBackup) || ups[0];
  return { TargetIp: p.Host, TargetPort: p.Port };
}

/** 操作紀錄用：後端清單轉成一行文字 */
const upText = (ups) => (ups || []).map((u) => `${u.Host}:${u.Port}${Number(u.Weight) > 1 ? ` 權重${u.Weight}` : ''}${u.IsBackup ? ' 備援' : ''}${u.IsActive === false ? ' 停用' : ''}`).join('、');

async function replaceUpstreams(ruleId, ups, transaction) {
  await RuleUpstream.destroy({ where: { RuleId: ruleId }, transaction });
  await RuleUpstream.bulkCreate(ups.map((u) => ({ ...u, RuleId: ruleId })), { transaction });
}

async function loadRule(id) {
  return DomainRule.findByPk(id, { include: [withUpstreams], order: UP_ORDER });
}

router.get('/rules', wrap(async (req, res) => {
  res.json(await DomainRule.findAll({
    include: [{ model: SslCertificate, as: 'certificate', attributes: ['Id', 'Alias', 'ValidTo', 'SanDomains'] }, withUpstreams],
    order: [['DomainName', 'ASC'], ...UP_ORDER],
  }));
}));

router.post('/rules', wrap(async (req, res) => {
  const data = normalizeRule({ ClientMaxBodySize: '50M', LbMethod: 'round_robin', ...pick(req.body, RULE_FIELDS) });
  const ups = normalizeUpstreams(req.body || {});
  if (!ups) throw new HttpError(400, '至少要設定一台後端主機');
  await checkRule({ ...data, Upstreams: ups });
  const created = await sequelize.transaction(async (t) => {
    const rule = await DomainRule.create({ ...data, ...primaryOf(ups) }, { transaction: t });
    await replaceUpstreams(rule.Id, ups, t);
    return rule;
  });
  await audit.record(req, { action: 'CREATE', targetType: 'RULE', targetId: created.Id, targetName: created.DomainName, detail: { ...audit.snapshot(data), Upstreams: upText(ups) } });
  res.status(201).json(await loadRule(created.Id));
}));

router.put('/rules/:id', wrap(async (req, res) => {
  const rule = await loadRule(req.params.id);
  if (!rule) throw new HttpError(404, '規則不存在');
  const before = rule.get({ plain: true });
  const beforeUps = (before.Upstreams || []).map((u) => ({ ...u }));
  const data = normalizeRule(pick(req.body, RULE_FIELDS));
  const ups = normalizeUpstreams(req.body || {});
  await checkRule({ ...before, ...data, Upstreams: ups || beforeUps });
  await sequelize.transaction(async (t) => {
    await rule.update({ ...data, ...(ups ? primaryOf(ups) : {}) }, { transaction: t });
    if (ups) await replaceUpstreams(rule.Id, ups, t);
  });
  const detail = audit.diff({ ...before }, data);
  if (ups && upText(ups) !== upText(beforeUps)) detail.Upstreams = [upText(beforeUps), upText(ups)];
  await audit.record(req, { action: 'UPDATE', targetType: 'RULE', targetId: rule.Id, targetName: rule.DomainName, detail });
  res.json(await loadRule(rule.Id));
}));

router.delete('/rules/:id', wrap(async (req, res) => {
  const rule = await loadRule(req.params.id);
  if (!rule) throw new HttpError(404, '規則不存在');
  const plain = rule.get({ plain: true });
  await rule.destroy(); // RuleUpstreams 由外鍵 ON DELETE CASCADE 一併刪除
  await audit.record(req, { action: 'DELETE', targetType: 'RULE', targetId: rule.Id, targetName: rule.DomainName, detail: { ...audit.snapshot(plain, RULE_FIELDS), Upstreams: upText(plain.Upstreams) } });
  res.json({ ok: true });
}));

/** 預覽該規則將生成的 Nginx 設定檔 */
router.get('/rules/:id/preview', wrap(async (req, res) => {
  const rule = await loadRule(req.params.id);
  if (!rule) throw new HttpError(404, '規則不存在');
  res.type('text/plain; charset=utf-8').send(renderConf(rule.get({ plain: true })));
}));

/* =============================================================== 部署 */
router.get('/deploy/logs', wrap(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 30, 200);
  res.json(await DeployLog.findAll({
    attributes: { exclude: ['LogText', 'NodeResults'] },
    order: [['Id', 'DESC']],
    limit,
  }));
}));

router.get('/deploy/logs/:id', wrap(async (req, res) => {
  const log = await DeployLog.findByPk(req.params.id);
  if (!log) throw new HttpError(404, '紀錄不存在');
  const plain = log.get({ plain: true });
  try { plain.NodeResults = plain.NodeResults ? JSON.parse(plain.NodeResults) : []; } catch (_) { plain.NodeResults = []; }
  res.json(plain);
}));

/** Server-Sent Events：即時推送部署日誌 */
router.get('/deploy/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  const onLog = (entry) => res.write(`data: ${JSON.stringify(entry)}\n\n`);
  const hb = setInterval(() => res.write(': ping\n\n'), 15000);
  deployService.bus.on('log', onLog);
  req.on('close', () => {
    clearInterval(hb);
    deployService.bus.off('log', onLog);
  });
});

router.post('/deploy', wrap(async (req, res) => {
  const result = await deployService.deploy({
    triggeredBy: String(req.user?.username || 'unknown').slice(0, 100),
    triggerIp: req.ip,
  });
  await audit.record(req, {
    action: 'DEPLOY', targetType: 'DEPLOY', targetId: result.logId, targetName: `部署紀錄 #${result.logId || '-'}`,
    success: result.ok, detail: { status: result.status, message: result.message },
  });
  // 失敗（含 nginx -t 失敗已回滾）回 422，body 內含 errorDetail（nginx -t 原始 stderr）供前端顯示
  res.status(result.ok ? 200 : 422).json(result);
}));

/* =============================================================== 操作紀錄 AuditLogs */
// LIKE 的萬用字元 % _ [ 需跳脫成 [%] [_] [[]
const likeEscape = (s) => s.replace(/[%_[]/g, (c) => `[${c}]`);

router.get('/audit-logs', wrap(async (req, res) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 50, 1), 200);
  const where = {};
  const q = String(req.query.q || '').trim().slice(0, 100);
  if (q) {
    const like = { [Op.like]: `%${likeEscape(q)}%` };
    where[Op.or] = [{ Username: like }, { TargetName: like }, { ClientIp: like }, { Detail: like }];
  }
  if (audit.ACTIONS.includes(req.query.action)) where.Action = req.query.action;
  if (audit.TARGETS.includes(req.query.targetType)) where.TargetType = req.query.targetType;
  const date = (v) => { const d = v ? new Date(v) : null; return d && !Number.isNaN(d.getTime()) ? d : null; };
  const from = date(req.query.from);
  const to = date(req.query.to);
  if (from || to) where.CreatedAt = { ...(from ? { [Op.gte]: from } : {}), ...(to ? { [Op.lt]: to } : {}) };
  const { count, rows } = await AuditLog.findAndCountAll({
    where, order: [['Id', 'DESC']], offset: (page - 1) * pageSize, limit: pageSize,
  });
  res.json({
    total: count,
    rows: rows.map((r) => {
      const p = r.get({ plain: true });
      try { p.Detail = p.Detail ? JSON.parse(p.Detail) : null; } catch (_) { /* 保留原字串 */ }
      return p;
    }),
  });
}));

/* =============================================================== 錯誤處理 */
router.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err.name === 'SequelizeUniqueConstraintError') return res.status(409).json({ message: '資料重複（名稱/網域已存在）' });
  if (err.name === 'SequelizeForeignKeyConstraintError') return res.status(409).json({ message: '資料仍被其他項目引用，無法刪除' });
  if (err instanceof multer.MulterError) return res.status(400).json({ message: `上傳失敗：${err.message}` });
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  return res.status(status).json({ message: status >= 500 ? `伺服器錯誤：${err.message}` : err.message });
});

module.exports = router;
