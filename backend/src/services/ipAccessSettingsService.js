'use strict';
/** 全域 IP 黑名單（IpAccessSettings 只有 Id = 1 一筆） */
const { IpAccessSetting } = require('../models');
const { parseList, formatList, MAX_GLOBAL_ENTRIES } = require('./ipAccessService');

const DEFAULTS = { Id: 1, BlockList: null, UpdatedBy: null, UpdatedAt: null };
const LIST_OPTS = { max: MAX_GLOBAL_ENTRIES, label: '全域黑名單' };

/** 讀取設定；資料表尚未建立（未執行新版 schema.sql）時視為沒有黑名單，不影響部署 */
async function get() {
  try {
    const row = await IpAccessSetting.findByPk(1);
    return row ? row.get({ plain: true }) : { ...DEFAULTS };
  } catch (e) {
    console.warn(`[ip] 無法讀取 IpAccessSettings（請執行 database/schema.sql）：${e.message}`);
    return { ...DEFAULTS, missingTable: true };
  }
}

/** 目前黑名單的有效項目（部署用） */
async function blockEntries() {
  const s = await get();
  return parseList(s.BlockList, LIST_OPTS).entries;
}

/** 更新黑名單；格式錯誤丟 400。回傳 { before, after, count } */
async function update(input, username) {
  const before = await get();
  if (before.missingTable) {
    const e = new Error('資料庫尚未建立 IpAccessSettings 資料表，請先執行 database/schema.sql');
    e.status = 409;
    throw e;
  }
  const { entries, errs } = parseList(input.BlockList, LIST_OPTS);
  if (errs.length) {
    const e = new Error(errs.join('；'));
    e.status = 400;
    throw e;
  }
  const values = { BlockList: formatList(entries), UpdatedBy: String(username || '').slice(0, 100) || null };
  const row = await IpAccessSetting.findByPk(1);
  if (row) await row.update(values);
  else await IpAccessSetting.create({ Id: 1, ...values });
  return { before, after: await get(), count: entries.length };
}

module.exports = { get, update, blockEntries, LIST_OPTS };
