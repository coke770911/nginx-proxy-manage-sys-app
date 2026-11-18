'use strict';
/**
 * 登入帳號管理
 * 可登入帳號 = .env ADMIN_ACCOUNTS（不可於介面修改） ∪ 資料表 AdminAccounts 中啟用的帳號
 * 兩者都只是「授權名單」，密碼一律交由 portal 認證 API 驗證，系統本身不保存密碼。
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

/** .env 特權帳號沒有資料表列，登入取得的「姓名 / 單位」暫存於記憶體（後端重啟後待下次登入再補上） */
const envProfiles = new Map(); // username -> { DisplayName, LastLoginAt }

/** 組「姓名 / 單位」字串（存入 DisplayName，上限 100 字） */
function profileText(name, departments) {
  let n = String(name || '').trim().replace(/\s+/g, ' ');
  let d = (departments || []).map((x) => String(x || '').trim()).filter(Boolean).join('、');
  // 認證回應的 DisplayName 為「單位 [單位…] 姓名職稱」（如「圖書資訊處 校務系統組 王小明職員」），
  // 沒有獨立單位欄位時拆成「姓名職稱 / 單位」，與欄位標題「姓名 / 單位」順序一致
  if (!d && n.includes(' ')) {
    const parts = n.split(' ');
    n = parts.pop();
    d = parts.join(' ');
  }
  return [n, d].filter(Boolean).join(' / ').slice(0, 100) || null;
}

/**
 * 登入成功：更新最後登入時間；profile 有值（認證 API 查到姓名或單位）時一併更新「姓名 / 單位」，
 * 查無資料或查詢失敗時保留原本的內容，不會清空。
 */
async function touchLogin(username, profile) {
  const u = norm(username);
  const values = { LastLoginAt: new Date() };
  if (profile) values.DisplayName = profile;
  if (isEnvAccount(u)) {
    envProfiles.set(u, { DisplayName: profile || envProfiles.get(u)?.DisplayName || null, LastLoginAt: values.LastLoginAt });
  }
  await AdminAccount.update(values, { where: { Username: u } }).catch(() => {});
}

/**
 * 以認證 API（userDataConnect，只需帳號、不需密碼）查詢並更新「姓名 / 單位」
 * @returns {Promise<{ username, before, after, changed, found }>}；查無資料時不改動
 */
async function syncProfile(username) {
  const portalAuth = require('./portalAuth'); // 延遲載入，避免循環相依
  const u = norm(username);
  const profile = await portalAuth.getUserData(u);
  const after = profile ? profileText(profile.name, profile.departments) : null;
  const row = await AdminAccount.findOne({ where: { Username: u } });
  const before = (isEnvAccount(u) ? envProfiles.get(u)?.DisplayName : null) || row?.DisplayName || null;
  if (!after) return { username: u, before, after: before, changed: false, found: false };
  if (isEnvAccount(u)) envProfiles.set(u, { ...(envProfiles.get(u) || {}), DisplayName: after });
  if (row && row.DisplayName !== after) await row.update({ DisplayName: after });
  return { username: u, before, after, changed: before !== after, found: true };
}

/** 介面用：env 帳號（唯讀）+ 資料庫帳號 */
async function listAll() {
  const rows = (await AdminAccount.findAll({ order: [['Username', 'ASC']] })).map((r) => ({ ...r.get({ plain: true }), Source: 'db' }));
  const env = config.auth.adminAccounts.map((u) => ({
    Id: null, Username: u, IsActive: true, Remark: '由 backend/.env 的 ADMIN_ACCOUNTS 設定', Source: 'env',
    DisplayName: envProfiles.get(u)?.DisplayName || rows.find((r) => r.Username === u)?.DisplayName || null,
    LastLoginAt: envProfiles.get(u)?.LastLoginAt || rows.find((r) => r.Username === u)?.LastLoginAt || null,
  }));
  // 同時存在於 env 與資料庫時，以 env 為準（資料庫那筆標示為重複）
  return [...env, ...rows.map((r) => (isEnvAccount(r.Username) ? { ...r, DuplicateOfEnv: true } : r))];
}

module.exports = { USERNAME_RE, norm, isEnvAccount, loginSource, profileText, touchLogin, syncProfile, listAll };
