'use strict';
/**
 * 網域名稱申請單留存（資安稽核用；不做申請流程，只記錄每條規則的申請人資料）
 * 申請日期以規則建立日期（CreatedAt）為準，不另外存。
 * 這些欄位只存在資料庫，不會寫進 Nginx 設定檔；匯出 CSV 會包含，屬個人資料請妥善保管。
 */
const FIELDS = [
  { key: 'ApplicantUnit', title: '申請單位', max: 100, alias: ['unit', 'department', '單位'] },
  { key: 'ApplicantName', title: '申請人', max: 50, alias: ['applicant', 'name', '申請人姓名'] },
  { key: 'ApplicantTitle', title: '申請人職稱', max: 50, alias: ['title', 'jobtitle', '職稱'] },
  { key: 'ApplicantExt', title: '申請人分機', max: 30, alias: ['ext', 'extension', 'phone', '分機'] },
  { key: 'ApplicantEmail', title: '申請人Email', max: 254, alias: ['email', 'mail', '申請人 email', '電子郵件'] },
];
const KEYS = FIELDS.map((f) => f.key);
const EMAIL_RE = /^[^\s@<>()",;:]{1,64}@([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const EXT_RE = /^[0-9#*()+\-,. ]{1,30}$/; // 例：2231、03-3227151#2231

/** 去頭尾空白、控制字元換成空白；空白 → null */
const clean = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/[\x00-\x1f\x7f]+/g, ' ').trim();
  return s || null;
};

/** 只整理物件中「有出現」的申請單欄位（PUT 部分更新時不影響其他欄位） */
function normalize(data) {
  KEYS.forEach((k) => {
    if (!(k in data)) return;
    data[k] = clean(data[k]);
    if (k === 'ApplicantEmail' && data[k]) data[k] = data[k].toLowerCase();
  });
  return data;
}

/** 回傳錯誤訊息陣列；全部欄位都是選填，有填才檢查長度與格式 */
function validate(r) {
  const errs = [];
  FIELDS.forEach((f) => {
    const v = r[f.key];
    if (v && String(v).length > f.max) errs.push(`${f.title}最多 ${f.max} 個字`);
  });
  if (r.ApplicantEmail && !EMAIL_RE.test(r.ApplicantEmail)) errs.push('申請人 Email 格式不正確');
  if (r.ApplicantExt && !EXT_RE.test(r.ApplicantExt)) errs.push('申請人分機只能填數字與 # - ( ) 等符號（例：2231）');
  return errs;
}

/** 是否已填申請單（以「申請單位」與「申請人」都有值為準） */
const isFilled = (r) => !!(r.ApplicantUnit && r.ApplicantName);

module.exports = { FIELDS, KEYS, normalize, validate, isFilled };
