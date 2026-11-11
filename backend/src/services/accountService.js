'use strict';
/**
 * 登入帳號管理
 * 可登入帳號 = .env ADMIN_ACCOUNTS（不可於介面修改） ∪ 資料表 AdminAccounts 中啟用的帳號
 * 兩者都只是「授權名單」，密碼一律交由 SOAP 驗證，系統本身不保存密碼。
 */
const config = require('../config');
const { AdminAccount } = require('../models');

const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,99}$/;
const norm = (u) => String(u || '').trim().toLowerCase();
const isEnvAccount = (u) => config.auth.adminAccounts.includes(norm(u));

/** @returns {Promise<'env'|'db'|null>} 帳號可登入的來源；null = 無權限 */
async function loginSource(username) {
  const u = norm(username);
  if (!u) return null;
  if (isEnvAccount(u)) return 'env';
  const row = await AdminAccount.findOne({ where: { Username: u, IsActive: true }, attributes: ['Id'] });
  return row ? 'db' : null;
}

async function touchLogin(username) {
  await AdminAccount.update({ LastLoginAt: new Date() }, { where: { Username: norm(username) } }).catch(() => {});
}

/** 介面用：env 帳號（唯讀）+ 資料庫帳號 */
async function listAll() {
  const rows = (await AdminAccount.findAll({ order: [['Username', 'ASC']] })).map((r) => ({ ...r.get({ plain: true }), Source: 'db' }));
  const env = config.auth.adminAccounts.map((u) => ({
    Id: null, Username: u, DisplayName: null, IsActive: true, Remark: '由 backend/.env 的 ADMIN_ACCOUNTS 設定', Source: 'env',
    LastLoginAt: rows.find((r) => r.Username === u)?.LastLoginAt || null,
  }));
  // 同時存在於 env 與資料庫時，以 env 為準（資料庫那筆標示為重複）
  return [...env, ...rows.map((r) => (isEnvAccount(r.Username) ? { ...r, DuplicateOfEnv: true } : r))];
}

module.exports = { USERNAME_RE, norm, isEnvAccount, loginSource, touchLogin, listAll };
