'use strict';
/** 登入帳號管理 API（需登入）：/api/accounts */
const express = require('express');
const { AdminAccount } = require('../models');
const accounts = require('../services/accountService');
const audit = require('../services/auditService');

const router = express.Router();
const wrap = (fnc) => (req, res, next) => Promise.resolve(fnc(req, res, next)).catch(next);
const fail = (res, status, message) => res.status(status).json({ message });
const FIELDS = ['DisplayName', 'IsActive', 'Remark'];
const clean = (b) => {
  const out = {};
  if (b.DisplayName !== undefined) out.DisplayName = String(b.DisplayName || '').trim().slice(0, 100) || null;
  if (b.Remark !== undefined) out.Remark = String(b.Remark || '').trim().slice(0, 300) || null;
  if (b.IsActive !== undefined) out.IsActive = b.IsActive === true || b.IsActive === 1 || b.IsActive === 'true' || b.IsActive === '1';
  return out;
};

router.get('/', wrap(async (req, res) => res.json(await accounts.listAll())));

router.post('/', wrap(async (req, res) => {
  const username = accounts.norm(req.body?.Username);
  if (!accounts.USERNAME_RE.test(username)) return fail(res, 400, '帳號格式不正確（英數字開頭，可含 . _ @ -，最長 100 字）');
  if (accounts.isEnvAccount(username)) return fail(res, 409, '此帳號已在 .env 的 ADMIN_ACCOUNTS 中，不需重複新增');
  if (await AdminAccount.findOne({ where: { Username: username } })) return fail(res, 409, '此帳號已存在');
  const data = { IsActive: true, ...clean(req.body || {}), Username: username, CreatedBy: req.user.username };
  const row = await AdminAccount.create(data);
  await audit.record(req, { action: 'CREATE', targetType: 'ACCOUNT', targetId: row.Id, targetName: username, detail: audit.snapshot(data, ['Username', ...FIELDS]) });
  return res.status(201).json(row);
}));

router.put('/:id', wrap(async (req, res) => {
  const row = await AdminAccount.findByPk(req.params.id);
  if (!row) return fail(res, 404, '帳號不存在');
  const data = clean(req.body || {});
  if (data.IsActive === false && row.Username === accounts.norm(req.user.username) && !accounts.isEnvAccount(row.Username)) {
    return fail(res, 400, '不能停用自己目前登入的帳號');
  }
  const before = { ...row.get({ plain: true }) };
  await row.update(data);
  await audit.record(req, { action: 'UPDATE', targetType: 'ACCOUNT', targetId: row.Id, targetName: row.Username, detail: audit.diff(before, data) });
  return res.json(row);
}));

router.delete('/:id', wrap(async (req, res) => {
  const row = await AdminAccount.findByPk(req.params.id);
  if (!row) return fail(res, 404, '帳號不存在');
  if (row.Username === accounts.norm(req.user.username) && !accounts.isEnvAccount(row.Username)) {
    return fail(res, 400, '不能刪除自己目前登入的帳號');
  }
  await row.destroy();
  await audit.record(req, { action: 'DELETE', targetType: 'ACCOUNT', targetId: row.Id, targetName: row.Username, detail: audit.snapshot(row.get({ plain: true }), ['Username', ...FIELDS]) });
  return res.json({ ok: true });
}));

router.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err.name === 'SequelizeUniqueConstraintError') return fail(res, 409, '此帳號已存在');
  console.error(err);
  return fail(res, 500, `伺服器錯誤：${err.message}`);
});

module.exports = router;
