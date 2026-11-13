'use strict';
/** WAF 全域設定（WafSettings 只有 Id = 1 一筆） */
const { WafSetting } = require('../models');
const { validateSettings } = require('./wafService');

const DEFAULTS = { Id: 1, Enabled: false, ParanoiaLevel: 1, InboundThreshold: 5, UpdatedBy: null, UpdatedAt: null };

/** 讀取設定；資料表尚未建立（未執行新版 schema.sql）時視為關閉，不影響部署 */
async function get() {
  try {
    const row = await WafSetting.findByPk(1);
    return row ? row.get({ plain: true }) : { ...DEFAULTS };
  } catch (e) {
    console.warn(`[waf] 無法讀取 WafSettings（請執行 database/schema.sql）：${e.message}`);
    return { ...DEFAULTS, missingTable: true };
  }
}

/** 更新設定；回傳 { before, after } */
async function update(input, username) {
  const before = await get();
  if (before.missingTable) {
    const e = new Error('資料庫尚未建立 WafSettings 資料表，請先執行 database/schema.sql');
    e.status = 409;
    throw e;
  }
  const next = {
    Enabled: input.Enabled === undefined ? before.Enabled : input.Enabled === true || input.Enabled === 'true' || input.Enabled === 1,
    ParanoiaLevel: input.ParanoiaLevel === undefined ? before.ParanoiaLevel : Number(input.ParanoiaLevel),
    InboundThreshold: input.InboundThreshold === undefined ? before.InboundThreshold : Number(input.InboundThreshold),
  };
  const errs = validateSettings(next);
  if (errs.length) {
    const e = new Error(errs.join('；'));
    e.status = 400;
    throw e;
  }
  const values = { ...next, UpdatedBy: String(username || '').slice(0, 100) || null };
  const row = await WafSetting.findByPk(1);
  if (row) await row.update(values);
  else await WafSetting.create({ Id: 1, ...values });
  return { before, after: await get() };
}

module.exports = { get, update, DEFAULTS };
