'use strict';
/**
 * IP 群組（v1.0.17 起）
 *
 * - 群組 = 名稱 + 說明 + 位址清單；網域 IP 清單與全域黑名單用「@名稱」引用，部署時展開
 * - 群組內只能放 IP / CIDR，不可再引用群組（避免循環）
 * - 被引用中的群組：不可刪除、不可改名、不可清空（只允許清單引用空群組會變成全部拒絕）
 */
const { IpGroup, DomainRule, IpAccessSetting } = require('../models');
const ipAccess = require('./ipAccessService');

const ENTRY_OPTS = (name) => ({ max: ipAccess.MAX_GROUP_ENTRIES, label: `群組「${name}」`, allowGroups: false });

const httpError = (status, message) => Object.assign(new Error(message), { status });

/** 資料表尚未建立時視為沒有群組 */
async function rows() {
  try {
    return await IpGroup.findAll({ order: [['Name', 'ASC']] });
  } catch (e) {
    console.warn(`[ip] 無法讀取 IpGroups（請執行 database/schema.sql）：${e.message}`);
    return null;
  }
}

/** 部署 / 預覽用：Map<小寫名稱, { Name, entries }> */
async function loadMap() {
  const list = (await rows()) || [];
  return new Map(list.map((g) => [ipAccess.groupKey(g.Name), {
    Name: g.Name,
    entries: ipAccess.parseList(g.Entries, ENTRY_OPTS(g.Name)).entries,
  }]));
}

/** 每個群組被誰引用：Map<小寫名稱, string[]>（網域名稱或「全域黑名單」） */
async function usageMap() {
  const usage = new Map();
  const add = (key, who) => { if (!usage.has(key)) usage.set(key, []); usage.get(key).push(who); };
  const rules = await DomainRule.findAll({ attributes: ['DomainName', 'IpAccessMode', 'IpAccessList'] });
  rules.forEach((r) => {
    if (!r.IpAccessList || !r.IpAccessList.includes('@')) return;
    const tag = r.IpAccessMode === 'off' ? `${r.DomainName}（目前不限制）` : r.DomainName;
    ipAccess.groupRefs(r.IpAccessList).forEach((k) => add(k, tag));
  });
  try {
    const s = await IpAccessSetting.findByPk(1);
    if (s && s.BlockList) ipAccess.groupRefs(s.BlockList).forEach((k) => add(k, '全域黑名單'));
  } catch { /* 資料表不存在時略過 */ }
  return usage;
}

/** 管理頁用：群組清單 + 筆數 + 引用者 */
async function list() {
  const list0 = await rows();
  if (!list0) return { missingTable: true, groups: [] };
  const usage = await usageMap();
  return {
    groups: list0.map((g) => ({
      ...g.get({ plain: true }),
      count: ipAccess.parseList(g.Entries, ENTRY_OPTS(g.Name)).entries.length,
      usedBy: usage.get(ipAccess.groupKey(g.Name)) || [],
    })),
  };
}

/**
 * 確認清單文字引用的群組都存在；不存在丟 400
 * （網域規則、全域黑名單儲存前呼叫）
 */
async function assertRefsExist(text, label = 'IP 清單') {
  const refs = ipAccess.groupRefs(text);
  if (!refs.length) return;
  const map = await loadMap();
  const missing = refs.filter((k) => !map.has(k));
  if (missing.length) throw httpError(400, `${label}引用了不存在的 IP 群組：${missing.map((m) => `@${m}`).join('、')}`);
}

function cleanInput(input) {
  const Name = String(input.Name || '').trim().replace(/^@/, '');
  const Description = String(input.Description || '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 200) || null;
  if (!ipAccess.GROUP_NAME_RE.test(Name)) throw httpError(400, '群組名稱只能用中英文、數字、底線或連字號，1–30 字（不含空白）');
  const { entries, errs } = ipAccess.parseList(input.Entries, ENTRY_OPTS(Name));
  if (errs.length) throw httpError(400, errs.join('；'));
  return { Name, Description, entries };
}

async function assertNameFree(name, exceptId) {
  const all = (await rows()) || [];
  const dup = all.find((g) => ipAccess.groupKey(g.Name) === ipAccess.groupKey(name) && g.Id !== exceptId);
  if (dup) throw httpError(400, `已有名稱為「${dup.Name}」的群組`);
}

async function create(input, username) {
  if (!(await rows())) throw httpError(409, '資料庫尚未建立 IpGroups 資料表，請先執行 database/schema.sql');
  const { Name, Description, entries } = cleanInput(input);
  await assertNameFree(Name);
  const g = await IpGroup.create({ Name, Description, Entries: ipAccess.formatList(entries), UpdatedBy: String(username || '').slice(0, 100) || null });
  return g.get({ plain: true });
}

async function update(id, input, username) {
  const g = await IpGroup.findByPk(id);
  if (!g) throw httpError(404, '群組不存在');
  const before = g.get({ plain: true });
  const { Name, Description, entries } = cleanInput(input);
  await assertNameFree(Name, g.Id);
  const usedBy = (await usageMap()).get(ipAccess.groupKey(g.Name)) || [];
  if (usedBy.length && ipAccess.groupKey(Name) !== ipAccess.groupKey(g.Name)) {
    throw httpError(400, `群組正被 ${usedBy.join('、')} 引用，不能改名（請先移除引用）`);
  }
  if (usedBy.length && !entries.length) {
    throw httpError(400, `群組正被 ${usedBy.join('、')} 引用，至少要保留一筆位址`);
  }
  await g.update({ Name: usedBy.length ? g.Name : Name, Description, Entries: ipAccess.formatList(entries), UpdatedBy: String(username || '').slice(0, 100) || null });
  return { before, after: g.get({ plain: true }), usedBy };
}

async function remove(id) {
  const g = await IpGroup.findByPk(id);
  if (!g) throw httpError(404, '群組不存在');
  const usedBy = (await usageMap()).get(ipAccess.groupKey(g.Name)) || [];
  if (usedBy.length) throw httpError(400, `群組正被 ${usedBy.join('、')} 引用，請先移除引用再刪除`);
  const before = g.get({ plain: true });
  await g.destroy();
  return before;
}

module.exports = { loadMap, list, usageMap, assertRefsExist, create, update, remove };
