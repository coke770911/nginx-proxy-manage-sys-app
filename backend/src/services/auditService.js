'use strict';
/**
 * 系統操作紀錄（AuditLogs）
 * - 記錄登入、規則 / 憑證 / 節點的新增修改刪除、部署
 * - 寫入失敗只記錄到 console，不影響原本操作
 * - 絕不記錄密碼、私鑰、憑證內容
 */
const { AuditLog } = require('../models');

const ACTIONS = ['LOGIN', 'LOGIN_FAILED', 'CREATE', 'UPDATE', 'DELETE', 'RENEW', 'DEPLOY', 'CUTOVER_CHECK'];
const TARGETS = ['AUTH', 'RULE', 'CERT', 'NODE', 'DEPLOY', 'ACCOUNT'];
const SECRET_KEYS = new Set(['CertPem', 'KeyPem', 'password', 'pfxPassword']);
const MAX_VALUE = 300;

const clip = (v) => {
  if (v === null || v === undefined) return v;
  if (v instanceof Date) return v.toISOString();
  return typeof v === 'string' && v.length > MAX_VALUE ? `${v.slice(0, MAX_VALUE)}…（共 ${v.length} 字）` : v;
};

/** 只保留有變動的欄位：{ 欄位: [舊值, 新值] } */
function diff(before, after) {
  const out = {};
  Object.keys(after || {}).forEach((k) => {
    if (SECRET_KEYS.has(k)) return;
    const a = before ? before[k] : undefined;
    const b = after[k];
    const norm = (x) => (x instanceof Date ? x.toISOString() : x === undefined ? null : x);
    if (JSON.stringify(norm(a)) !== JSON.stringify(norm(b))) out[k] = [clip(a), clip(b)];
  });
  return out;
}

/** 移除機密欄位並截斷長字串，用於新增 / 刪除時保存當下內容 */
function snapshot(obj, keys) {
  const out = {};
  (keys || Object.keys(obj || {})).forEach((k) => {
    if (!SECRET_KEYS.has(k) && obj[k] !== undefined) out[k] = clip(obj[k]);
  });
  return out;
}

/**
 * @param {import('express').Request} req
 * @param {{action:string,targetType:string,targetId?:any,targetName?:string,detail?:object,success?:boolean,username?:string}} e
 */
async function record(req, e) {
  try {
    await AuditLog.create({
      Username: String(e.username || req.user?.username || 'unknown').slice(0, 100),
      ClientIp: String(req.ip || '').slice(0, 64),
      Action: e.action,
      TargetType: e.targetType,
      TargetId: e.targetId === undefined || e.targetId === null ? null : String(e.targetId).slice(0, 50),
      TargetName: e.targetName ? String(e.targetName).slice(0, 300) : null,
      Success: e.success !== false,
      Detail: e.detail && Object.keys(e.detail).length ? JSON.stringify(e.detail) : null,
    });
  } catch (err) {
    console.error('[audit] 寫入操作紀錄失敗：', err.message);
  }
}

module.exports = { record, diff, snapshot, ACTIONS, TARGETS };
