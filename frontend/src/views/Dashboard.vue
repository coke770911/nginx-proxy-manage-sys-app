<script setup>
import { ref, reactive, computed, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Upload, Refresh, Plus, Edit, Delete, View, UploadFilled, SwitchButton, Search, Connection, Download, Document, Aim, Lock } from '@element-plus/icons-vue';
import api, { eventsUrl, session, logout } from '../api';

/* ------------------------------------------------------------------ 資料 */
const nodes = ref([]);
const certs = ref([]);
const rules = ref([]);
const logs = ref([]);
const tab = ref('rules');
const loading = ref(false);
const checking = ref(false);

async function loadAll() {
  loading.value = true;
  try {
    [nodes.value, certs.value, rules.value, logs.value] = await Promise.all([
      api.get('/nodes'), api.get('/certificates'), api.get('/rules'), api.get('/deploy/logs'),
    ]);
    loadWaf();
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    loading.value = false;
  }
  loadBackendStatus();
}

/* ------------------------------------------------------------------ 後端連線燈號 */
// 由後端隨節點健康檢查（HEALTH_INTERVAL_SEC）從各節點測 TCP；前端只讀結果，不會即時去測
const backendSt = ref({ checkedAt: null, intervalSec: 60, backends: {} });
async function loadBackendStatus() {
  try { backendSt.value = await api.get('/backend-status'); } catch { /* 燈號為輔助資訊，失敗不打擾使用者 */ }
}
/** 燈號文字沿用下方「從節點測試後端連線」的 PROBE_TEXT；回傳 { cls: green|yellow|red|grey|off, tip } */
function backendLight(u) {
  if (!u.IsActive) return { cls: 'off', tip: '此後端已停用，不檢測' };
  const list = backendSt.value.backends[`${String(u.Host).toLowerCase()}:${u.Port}`] || [];
  if (!list.length) return { cls: 'grey', tip: '尚未檢測（每次節點健康檢查時更新）' };
  const ok = list.filter((r) => r.status === 'OK').length;
  const cls = ok === list.length ? 'green' : ok ? 'yellow' : 'red';
  const lines = list.map((r) => `${r.nodeName}：${PROBE_TEXT[r.status] || r.status}${r.status === 'OK' && r.ms != null ? `（${r.ms} ms）` : ''}`);
  const at = list.map((r) => r.at).sort().pop();
  return { cls, tip: `${lines.join('\n')}\n檢測時間：${fmt(at)}` };
}
let backendTimer = null;

/* ------------------------------------------------------------------ 共用工具 */
const pad2 = (n) => String(n).padStart(2, '0');
/** 統一的當地時間格式：YYYY/MM/DD HH:mm:ss */
const fmt = (d) => {
  if (!d) return '—';
  const t = new Date(d);
  if (Number.isNaN(t.getTime())) return String(d);
  return `${t.getFullYear()}/${pad2(t.getMonth() + 1)}/${pad2(t.getDate())} ${pad2(t.getHours())}:${pad2(t.getMinutes())}:${pad2(t.getSeconds())}`;
};
/** 距今幾天沒變動（以當地日曆日計算，今天更動＝0） */
const idleDays = (d) => {
  const t = new Date(d);
  if (!d || Number.isNaN(t.getTime())) return null;
  const today = new Date();
  const a = Date.UTC(t.getFullYear(), t.getMonth(), t.getDate());
  const b = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.max(0, Math.round((b - a) / 86400000));
};
const idleText = (d) => {
  const n = idleDays(d);
  if (n === null) return '';
  return n === 0 ? '今天有更動' : `${n} 天沒變動`;
};
/** 規則網址：有綁憑證走 https，否則 http */
const siteUrl = (r) => `${r.CertificateId ? 'https' : 'http'}://${r.DomainName}/`;
/** 舊部署紀錄每行開頭是 UTC ISO 時間，轉成當地時間顯示 */
const localizeLog = (text) => String(text || '').replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/gm, (iso) => fmt(iso));
const daysLeft = (d) => Math.floor((new Date(d).getTime() - Date.now()) / 86400000);

function certTag(validTo) {
  const n = daysLeft(validTo);
  if (n < 0) return { type: 'danger', text: `已過期 ${-n} 天` };
  if (n <= 14) return { type: 'danger', text: `剩 ${n} 天` };
  if (n <= 30) return { type: 'warning', text: `剩 ${n} 天` };
  if (n <= 60) return { type: 'primary', text: `剩 ${n} 天` };
  return { type: 'success', text: `剩 ${n} 天` };
}

const LIGHT = { ONLINE: 'green', DEGRADED: 'yellow', OFFLINE: 'red', UNKNOWN: 'grey' };
const HEALTH_TEXT = { ONLINE: '連線正常', DEGRADED: 'SSH 正常 / Nginx 異常', OFFLINE: '無法連線', UNKNOWN: '尚未檢測' };
// 資源使用率：< 70% 綠、70–90% 黃、> 90% 紅
const usageColor = (p) => (p >= 90 ? '#f56c6c' : p >= 70 ? '#e6a23c' : '#67c23a');
const gb = (b) => (b >= 1024 ** 4 ? `${(b / 1024 ** 4).toFixed(1)} TB` : `${(b / 1024 ** 3).toFixed(1)} GB`);
const resRows = (st) => [
  st.cpu !== null && st.cpu !== undefined && { label: 'CPU', p: st.cpu, text: st.cores ? `${st.cpu}% · ${st.cores} 核` : `${st.cpu}%`, tip: `${st.cores || '?'} 核心，負載 ${(st.load || []).join(' / ')}（1 / 5 / 15 分鐘）` },
  st.mem && { label: 'RAM', p: st.mem.percent, text: `${gb(st.mem.used)} / ${gb(st.mem.total)}`, tip: st.swap ? `Swap ${gb(st.swap.used)} / ${gb(st.swap.total)}` : '無 Swap' },
  st.disk && { label: '硬碟', p: st.disk.percent, text: `剩 ${gb(st.disk.free)}`, tip: `/ 已用 ${gb(st.disk.used)}，共 ${gb(st.disk.total)}` },
].filter(Boolean);

const lightClass = (n) => (n.IsActive ? LIGHT[n.HealthStatus] || 'grey' : 'off');

const STATUS_TAG = {
  SUCCESS: { type: 'success', text: '成功' },
  FAILED: { type: 'danger', text: '失敗' },
  ROLLED_BACK: { type: 'warning', text: '已回滾' },
  PARTIAL: { type: 'warning', text: '部分成功' },
  RUNNING: { type: 'info', text: '執行中' },
};

/* ------------------------------------------------------------------ 規則搜尋（網域 / IP） */
const ruleQuery = ref('');
const filteredRules = computed(() => {
  const q = ruleQuery.value.trim().toLowerCase();
  if (!q) return rules.value;
  return rules.value.filter((r) => r.DomainName.toLowerCase().includes(q)
    || ruleUpstreams(r).some((u) => `${u.Host}:${u.Port}`.toLowerCase().includes(q)));
});

/* ------------------------------------------------------------------ 操作紀錄 */
const AUDIT_ACTION = {
  LOGIN: { type: 'success', text: '登入' },
  LOGIN_FAILED: { type: 'danger', text: '登入失敗' },
  CREATE: { type: 'primary', text: '新增' },
  UPDATE: { type: 'warning', text: '修改' },
  DELETE: { type: 'danger', text: '刪除' },
  RENEW: { type: 'warning', text: '憑證續約' },
  DEPLOY: { type: 'info', text: '部署' },
  CUTOVER_CHECK: { type: 'info', text: '切換前檢查' },
};
const AUDIT_TARGET = { AUTH: '登入', RULE: '網域規則', CERT: 'SSL 憑證', NODE: 'Nginx 節點', DEPLOY: '部署', ACCOUNT: '帳號管理', WAF: 'WAF 設定' };
const audit = reactive({ q: '', action: '', targetType: '', range: null, page: 1, pageSize: 50, total: 0, rows: [], loading: false });

async function loadAudit(resetPage = false) {
  if (resetPage) audit.page = 1;
  audit.loading = true;
  try {
    const [from, to] = audit.range || [];
    const params = { q: audit.q || undefined, action: audit.action || undefined, targetType: audit.targetType || undefined, page: audit.page, pageSize: audit.pageSize };
    if (from) params.from = new Date(from).toISOString();
    if (to) params.to = new Date(new Date(to).getTime() + 86400000).toISOString(); // 含結束當天
    const data = await api.get('/audit-logs', { params });
    audit.rows = data.rows;
    audit.total = data.total;
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    audit.loading = false;
  }
}

const FIELD_LABEL = {
  DomainName: '來源網域', TargetIp: '後端 IP', TargetPort: '後端 Port', CertificateId: '憑證 ID', ForceHttps: '強制 HTTPS',
  EnableWebSocket: 'WebSocket', ClientMaxBodySize: '上傳上限', IsActive: '啟用', IsMaintenance: '維護中頁面',
  CustomNginxSnippet: '自訂 Nginx 語法', Remark: '備註', NodeName: '節點名稱', IpAddress: 'IP', SshPort: 'SSH Port',
  SshUser: 'SSH 帳號', SshKeyPath: '私鑰路徑', HostKeySha256: '主機指紋', Alias: '別名', SanDomains: '涵蓋網域',
  Issuer: '發行商', Fingerprint: '憑證指紋', ValidTo: '到期日', Username: '帳號', DisplayName: '姓名 / 單位',
  Upstreams: '後端主機', LbMethod: '分配方式', LbCookieName: 'Cookie 名稱',
  WafMode: 'WAF 模式', WafExcludeIds: 'WAF 排除規則', Enabled: 'WAF 總開關', ParanoiaLevel: '嚴格程度', InboundThreshold: '阻擋門檻',
  reason: '原因', source: '帳號來源', status: '狀態', message: '訊息',
};
const auditDetail = (d) => {
  if (!d) return '';
  if (typeof d === 'string') return d;
  return Object.entries(d).map(([k, v]) => (Array.isArray(v) && v.length === 2
    ? `${FIELD_LABEL[k] || k}：${fmtVal(v[0])} → ${fmtVal(v[1])}`
    : `${FIELD_LABEL[k] || k}：${fmtVal(v)}`)).join('\n');
};
const fmtVal = (v) => (v === null || v === undefined || v === '' ? '（空）' : typeof v === 'boolean' ? (v ? '是' : '否') : String(v));

/* ------------------------------------------------------------------ 登入帳號管理 */
const accounts = ref([]);
const accountsLoading = ref(false);
const blankAccount = () => ({ Username: '', DisplayName: '', Remark: '', IsActive: true });
const accDlg = reactive({ visible: false, id: null, saving: false, form: blankAccount() });
const accFormRef = ref();
const accRules = {
  Username: [
    { required: true, message: '請輸入帳號', trigger: 'blur' },
    { pattern: /^[A-Za-z0-9][A-Za-z0-9._@-]{0,99}$/, message: '英數字開頭，可含 . _ @ -', trigger: 'blur' },
  ],
};

async function loadAccounts() {
  accountsLoading.value = true;
  try { accounts.value = await api.get('/accounts'); } catch (e) { ElMessage.error(e.message); } finally { accountsLoading.value = false; }
}

function openAccount(row) {
  Object.assign(accDlg, { visible: true, id: row?.Id || null, saving: false, form: row ? { Username: row.Username, DisplayName: row.DisplayName || '', Remark: row.Remark || '', IsActive: row.IsActive } : blankAccount() });
  nextTick(() => accFormRef.value?.clearValidate());
}

async function saveAccount() {
  if (!(await accFormRef.value.validate().catch(() => false))) return;
  accDlg.saving = true;
  try {
    const { Username, ...rest } = accDlg.form;
    if (accDlg.id) await api.put(`/accounts/${accDlg.id}`, rest);
    else await api.post('/accounts', { Username, ...rest });
    ElMessage.success('已儲存');
    accDlg.visible = false;
    await loadAccounts();
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    accDlg.saving = false;
  }
}

async function toggleAccount(row, v) {
  try {
    await api.put(`/accounts/${row.Id}`, { IsActive: v });
    row.IsActive = v;
    ElMessage.success(v ? `已啟用 ${row.Username}` : `已停用 ${row.Username}，該帳號下一次操作即失去權限`);
  } catch (e) {
    ElMessage.error(e.message);
  }
}

async function removeAccount(row) {
  try {
    await ElMessageBox.confirm(`確定刪除帳號「${row.Username}」？刪除後該帳號立即無法使用本系統。`, '刪除帳號', { type: 'warning', confirmButtonText: '刪除', cancelButtonText: '取消' });
  } catch { return; }
  try {
    await api.delete(`/accounts/${row.Id}`);
    ElMessage.success('已刪除');
    await loadAccounts();
  } catch (e) {
    ElMessage.error(e.message);
  }
}

function onTabChange(name) {
  if (name === 'audit') loadAudit();
  if (name === 'accounts') loadAccounts();
}

// 有規則/憑證在最近一次成功部署之後被修改 → 提示尚未部署
const pendingChanges = computed(() => {
  const last = logs.value.find((l) => l.Status === 'SUCCESS');
  const lastTs = last?.FinishedAt ? new Date(last.FinishedAt).getTime() : 0;
  const newest = Math.max(0, ...rules.value.map((r) => new Date(r.UpdatedAt).getTime()), ...certs.value.map((c) => new Date(c.UpdatedAt).getTime()),
    // WafSettings 只有被人修改過（UpdatedBy 有值）才算；資料表剛建立時的初始時間不算變更
    wafCfg.value.UpdatedAt && wafCfg.value.UpdatedBy ? new Date(wafCfg.value.UpdatedAt).getTime() : 0);
  return newest > lastTs;
});

/* ------------------------------------------------------------------ WAF（ModSecurity + OWASP CRS） */
const WAF_MODE = {
  off: { text: '關閉', type: 'info', hint: '不檢查' },
  detect: { text: '僅偵測', type: 'warning', hint: '只記錄可疑請求，不阻擋（建議先觀察 1–2 週，找出誤判再改阻擋）' },
  block: { text: '阻擋', type: 'danger', hint: '判定為攻擊的請求直接回 403' },
};
const PARANOIA = [
  { v: 1, text: '1 標準', hint: '誤判最少，建議大多數網站使用' },
  { v: 2, text: '2 加強', hint: '多檢查一些攻擊手法，誤判稍多' },
  { v: 3, text: '3 嚴格', hint: '誤判明顯增加，需要大量排除設定' },
  { v: 4, text: '4 極嚴格', hint: '只適合高敏感系統，誤判非常多' },
];
const wafCfg = ref({ Enabled: false, ParanoiaLevel: 1, InboundThreshold: 5, ruleCounts: { detect: 0, block: 0 } });
const wafForm = reactive({ Enabled: false, ParanoiaLevel: 1, InboundThreshold: 5 });
const wafSaving = ref(false);
async function loadWaf() {
  try {
    wafCfg.value = await api.get('/waf/settings');
    Object.assign(wafForm, { Enabled: wafCfg.value.Enabled, ParanoiaLevel: wafCfg.value.ParanoiaLevel, InboundThreshold: wafCfg.value.InboundThreshold });
  } catch { /* 舊版資料庫沒有 WafSettings 時不打擾使用者 */ }
}
const wafDirty = computed(() => wafForm.Enabled !== wafCfg.value.Enabled || wafForm.ParanoiaLevel !== wafCfg.value.ParanoiaLevel || wafForm.InboundThreshold !== wafCfg.value.InboundThreshold);
async function saveWaf() {
  wafSaving.value = true;
  try {
    await api.put('/waf/settings', { ...wafForm });
    ElMessage.success('已儲存（需按「一鍵同步部署」才會生效）');
    await loadWaf();
  } catch (e) { ElMessage.error(e.message); } finally { wafSaving.value = false; }
}
/** 節點 WAF 模組狀態（健康檢查時更新） */
const nodeWaf = (n) => n.Stats?.waf || null;
/** 節點版本（OS、nginx、libmodsecurity；健康檢查時更新） */
const nodeVer = (n) => n.Stats?.versions || null;
const upstreamVer = (v) => (v ? String(v).replace(/^\d+:/, '').replace(/[-+~].*$/, '') : null); // 3.3.8-1 → 3.3.8
function wafVerText(n) {
  const crs = upstreamVer(nodeWaf(n)?.crsVersion);
  const ms = nodeVer(n)?.modsecurity;
  return [ms && `ModSecurity ${ms}`, crs && `CRS ${crs}`].filter(Boolean).join(' · ') || '模組已安裝';
}
const wafNodesMissing = computed(() => nodes.value.filter((n) => n.IsActive && n.Stats && !n.Stats.error && nodeWaf(n) && !nodeWaf(n).ready));
/** 規則清單的 WAF 欄位：總開關關閉時以灰色標示「未生效」 */
function wafTag(r) {
  const m = WAF_MODE[r.WafMode || 'off'] || WAF_MODE.off;
  if ((r.WafMode || 'off') === 'off') return { text: '關閉', type: 'info', tip: '' };
  if (!wafCfg.value.Enabled) return { text: m.text, type: 'info', tip: 'WAF 總開關關閉中，此設定尚未生效' };
  if (r.IsMaintenance) return { text: m.text, type: 'info', tip: '維護中頁面不經過 WAF' };
  const ex = r.WafExcludeIds ? r.WafExcludeIds.split(',').length : 0;
  return { text: m.text, type: m.type, tip: ex ? `排除 ${ex} 條規則：${r.WafExcludeIds}` : '' };
}

/* ------------------------------------------------------------------ 節點 */
async function checkNodes() {
  checking.value = true;
  try {
    nodes.value = await api.post('/nodes/check');
    await loadBackendStatus();
    ElMessage.success('節點與後端連線檢測完成');
  } catch (e) { ElMessage.error(e.message); } finally { checking.value = false; }
}

async function toggleNode(n, v) {
  try {
    await api.put(`/nodes/${n.Id}`, { IsActive: v });
    n.IsActive = v;
  } catch (e) { ElMessage.error(e.message); }
}

/* ------------------------------------------------------------------ 節點 CRUD */
const blankNode = () => ({
  NodeName: '', IpAddress: '', SshPort: 22, SshUser: 'deployer', SshKeyPath: '', HostKeySha256: '', IsActive: true,
});
const pickNode = (n) => Object.fromEntries(Object.keys(blankNode()).map((k) => [k, n[k] ?? blankNode()[k]]));
const nodeDlg = reactive({ visible: false, id: null, saving: false, probing: false, form: blankNode() });
const nodeFormRef = ref();
const HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,253}[A-Za-z0-9])?$/;
const nodeRules = {
  NodeName: [{ required: true, message: '請輸入節點名稱', trigger: 'blur' }],
  IpAddress: [
    { required: true, message: '請輸入 IP 或主機名稱', trigger: 'blur' },
    { pattern: HOST_RE, message: 'IP / 主機名稱格式不正確', trigger: 'blur' },
  ],
  SshUser: [
    { required: true, message: '請輸入 SSH 帳號', trigger: 'blur' },
    { pattern: /^[a-z_][a-z0-9_-]{0,31}$/i, message: 'SSH 帳號格式不正確', trigger: 'blur' },
  ],
  HostKeySha256: [{ pattern: /^(SHA256:[A-Za-z0-9+/]{43}=?)?$/, message: '格式應為 SHA256:xxxx', trigger: 'blur' }],
};

function openNode(row) {
  nodeDlg.id = row ? row.Id : null;
  nodeDlg.form = row ? pickNode(row) : blankNode();
  nodeDlg.visible = true;
  nextTick(() => nodeFormRef.value?.clearValidate());
}

async function probeFingerprint() {
  const { IpAddress, SshPort } = nodeDlg.form;
  if (!HOST_RE.test(IpAddress || '')) return ElMessage.warning('請先輸入正確的 IP');
  nodeDlg.probing = true;
  try {
    const res = await api.post('/nodes/fingerprint', { IpAddress, SshPort });
    const old = nodeDlg.form.HostKeySha256;
    nodeDlg.form.HostKeySha256 = res.fingerprint;
    if (old && old !== res.fingerprint) ElMessage.warning('讀到的指紋與原本設定不同，請確認主機是否重灌或遭冒充');
    else ElMessage.success('已讀取主機金鑰指紋，請與主機上 ssh-keygen 的結果核對');
  } catch (e) { ElMessage.error(e.message); } finally { nodeDlg.probing = false; }
  return undefined;
}

async function saveNode() {
  await nodeFormRef.value.validate();
  nodeDlg.saving = true;
  try {
    if (nodeDlg.id) await api.put(`/nodes/${nodeDlg.id}`, nodeDlg.form);
    else await api.post('/nodes', nodeDlg.form);
    ElMessage.success('節點已儲存，可按重新檢測確認連線');
    nodeDlg.visible = false;
    await loadAll();
  } catch (e) { ElMessage.error(e.message); } finally { nodeDlg.saving = false; }
}

async function removeNode(row) {
  try {
    await ElMessageBox.confirm(
      `確定刪除節點「${row.NodeName}（${row.IpAddress}）」？刪除後部署不再推送到這台主機，但不會清除主機上已部署的設定。`,
      '刪除確認', { type: 'warning' },
    );
  } catch { return; }
  try {
    await api.delete(`/nodes/${row.Id}`);
    ElMessage.success('已刪除');
    await loadAll();
  } catch (e) { ElMessage.error(e.message); }
}

/* ------------------------------------------------------------------ 網域規則 CRUD */
const blankUpstream = () => ({ Host: '', Port: 80, Weight: 1, IsBackup: false, IsActive: true });
const blankRule = () => ({
  DomainName: '', CertificateId: null,
  ForceHttps: true, EnableWebSocket: false, ClientMaxBodySize: '2M',
  IsActive: true, IsMaintenance: false, CustomNginxSnippet: '', Remark: '',
  LbMethod: 'round_robin', LbCookieName: '', Upstreams: [blankUpstream()],
  WafMode: 'off', WafExcludeIds: '',
});
const LB_METHOD = {
  round_robin: { text: '輪流', hint: '依權重輪流分配，適合大多數系統' },
  least_conn: { text: '最少連線', hint: '優先送給目前連線數最少的主機，適合處理時間長短差異大的系統' },
  cookie: { text: '依 Cookie 固定', hint: '同一個 Cookie 值固定送到同一台，適合登入狀態存在單台記憶體的舊系統；不可搭配備援機' },
};
const ruleUpstreams = (r) => (r.Upstreams && r.Upstreams.length ? r.Upstreams : [{ Host: r.TargetIp, Port: r.TargetPort, Weight: 1, IsBackup: false, IsActive: true }]);
const HOST_PATTERN = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,253}[A-Za-z0-9])?$/;
function validateUpstreams(_rule, _v, cb) {
  const f = ruleDlg.form;
  if (!f.Upstreams.length) return cb(new Error('至少要設定一台後端主機'));
  const bad = f.Upstreams.findIndex((u) => !HOST_PATTERN.test(String(u.Host || '').trim()));
  if (bad >= 0) return cb(new Error(`第 ${bad + 1} 台後端的 IP / 主機名稱格式不正確`));
  if (!f.Upstreams.some((u) => u.IsActive && !u.IsBackup)) return cb(new Error('至少要有一台「啟用中」且「非備援」的後端主機'));
  if (f.LbMethod === 'cookie' && f.Upstreams.some((u) => u.IsActive && u.IsBackup)) return cb(new Error('「依 Cookie 固定」不能搭配備援機'));
  return cb();
}
const ruleDlg = reactive({ visible: false, id: null, saving: false, form: blankRule() });
const ruleFormRef = ref();
const ruleRules = {
  DomainName: [{ required: true, message: '請輸入來源網域', trigger: 'blur' }],
  Upstreams: [{ validator: validateUpstreams, trigger: 'submit' }],
  LbCookieName: [{ validator: (_r, v, cb) => (ruleDlg.form.LbMethod !== 'cookie' || /^[A-Za-z0-9_]{1,64}$/.test(v || '') ? cb() : cb(new Error('Cookie 名稱只能用英數字與底線'))), trigger: 'blur' }],
  CertificateId: [{ required: true, message: '請選擇 SSL 憑證', trigger: 'change' }],
  WafExcludeIds: [{ validator: (_r, v, cb) => (String(v || '').split(/[s,，、]+/).filter(Boolean).every((x) => /^d{6,7}$/.test(x)) ? cb() : cb(new Error('只能填 6–7 位數字的規則 ID，以逗號分隔'))), trigger: 'blur' }],
};

function openRule(row) {
  ruleDlg.id = row ? row.Id : null;
  ruleDlg.form = row
    ? { ...blankRule(), ...row, certificate: undefined, LbCookieName: row.LbCookieName || '', WafMode: row.WafMode || 'off', WafExcludeIds: row.WafExcludeIds || '', Upstreams: ruleUpstreams(row).map(({ Host, Port, Weight, IsBackup, IsActive }) => ({ Host, Port, Weight, IsBackup, IsActive })) }
    : blankRule();
  ruleDlg.visible = true;
}

async function saveRule() {
  await ruleFormRef.value.validate();
  ruleDlg.saving = true;
  try {
    const body = { ...ruleDlg.form, Upstreams: ruleDlg.form.Upstreams.map((u) => ({ ...u, Host: String(u.Host).trim() })) };
    ['certificate', 'TargetIp', 'TargetPort', 'Id', 'CreatedAt', 'UpdatedAt'].forEach((k) => delete body[k]);
    if (ruleDlg.id) await api.put(`/rules/${ruleDlg.id}`, body);
    else await api.post('/rules', body);
    ElMessage.success('已儲存（需按「一鍵同步部署」才會生效）');
    ruleDlg.visible = false;
    await loadAll();
  } catch (e) { ElMessage.error(e.message); } finally { ruleDlg.saving = false; }
}

async function quickToggle(row, field, v) {
  try {
    await api.put(`/rules/${row.Id}`, { [field]: v });
    row[field] = v;
    row.UpdatedAt = new Date().toISOString();
  } catch (e) { ElMessage.error(e.message); }
}

/* ------------------------------------------------------------------ 從節點測試後端連線 */
const probeDlg = reactive({ visible: false, loading: false, title: '', targets: [], nodes: [], error: '' });
const PROBE_TAG = { OK: 'success', TIMEOUT: 'danger', REFUSED: 'danger', ERROR: 'info' };
const PROBE_TEXT = { OK: '可連線', TIMEOUT: '逾時', REFUSED: '拒絕連線', ERROR: '無結果' };
const probeCell = (node, t) => node.results.find((x) => x.host === t.host && x.port === t.port);
const probeAllOk = computed(() => probeDlg.nodes.length > 0 && probeDlg.nodes.every((n) => !n.error && n.results.every((x) => x.ok)));

async function runProbe(title, request) {
  Object.assign(probeDlg, { visible: true, loading: true, title, targets: [], nodes: [], error: '' });
  try {
    const data = await request();
    probeDlg.targets = data.targets;
    probeDlg.nodes = data.nodes;
  } catch (e) {
    probeDlg.error = e.message;
  } finally {
    probeDlg.loading = false;
  }
}
/* ------------------------------------------------------------------ 切換前檢查（DNS 改指 F5 VIP 前的模擬測試） */
const cutoverCfg = ref({ enabled: false, vip: null });
const ruleSelection = ref([]);
const cutDlg = reactive({ visible: false, loading: false, error: '', data: null, count: 0, filter: 'all' });
const CUT_VERDICT = {
  pass: { type: 'success', text: '可以切換' },
  warn: { type: 'warning', text: '有警告' },
  fail: { type: 'danger', text: '不要切換' },
  skip: { type: 'info', text: '略過' },
};
const CUT_ISSUE = { fail: 'danger', warn: 'warning', info: 'info' };
const cutResults = computed(() => {
  const list = cutDlg.data?.results || [];
  return cutDlg.filter === 'all' ? list : list.filter((r) => r.verdict === cutDlg.filter);
});
const cutCount = (v) => (cutDlg.data?.results || []).filter((r) => r.verdict === v).length;
const cutPassDomains = computed(() => (cutDlg.data?.results || []).filter((r) => r.verdict === 'pass' && !r.dns?.switched).map((r) => r.domain));
const cutDnsText = (r) => {
  if (!r.dns) return '—';
  if (r.dns.switched) return '已指向 VIP';
  if (!r.dns.ips.length) return r.dns.error || '查無紀錄';
  return `${r.dns.cname ? `CNAME ${r.dns.cname} → ` : ''}${r.dns.ips.join(', ')}`;
};
const cutStatusText = (list) => {
  const m = new Map();
  list.forEach((x) => { const k = x.status || '失敗'; m.set(k, (m.get(k) || 0) + 1); });
  return [...m].map(([k, n]) => (n > 1 ? `${k} ×${n}` : `${k}`)).join('、');
};

async function loadCutoverCfg() {
  try { cutoverCfg.value = await api.get('/cutover/config'); } catch { /* 功能設定讀不到時按鈕維持停用 */ }
}
async function runCutoverCheck(rows) {
  if (!cutoverCfg.value.enabled) {
    ElMessage.warning('尚未設定 F5 VIP：請在 backend/.env 設定 CUTOVER_VIP 後重新啟動服務');
    return;
  }
  const ids = rows.map((r) => r.Id);
  if (ids.length > 50) { ElMessage.warning('一次最多檢查 50 筆規則'); return; }
  Object.assign(cutDlg, { visible: true, loading: true, error: '', data: null, count: ids.length, filter: 'all' });
  try {
    cutDlg.data = await api.post('/rules/cutover-check', { ids }, { timeout: 600000 });
  } catch (e) {
    cutDlg.error = e.message;
  } finally {
    cutDlg.loading = false;
  }
}
async function copyPassDomains() {
  const text = cutPassDomains.value.join('\n');
  try {
    await navigator.clipboard.writeText(text);
    ElMessage.success(`已複製 ${cutPassDomains.value.length} 個網域`);
  } catch {
    ElMessageBox.alert(`<pre style="margin:0">${text}</pre>`, '可以切換的網域', { dangerouslyUseHTMLString: true });
  }
}

/* ------------------------------------------------------------------ 規則匯入 / 匯出（CSV） */
const IMPORT_TEMPLATE = [
  '來源網域,後端主機,分配方式,Cookie名稱,SSL憑證,強制HTTPS,WebSocket,上傳上限,啟用,維護中,備註',
  'portal.example.edu.tw,10.0.0.21:8080,,,,是,否,50M,是,否,單一後端',
  'app.example.edu.tw,10.0.0.31:8080*3; 10.0.0.32:8080; 10.0.0.33:8080(備援),最少連線,,,是,否,100M,是,否,三台後端：權重 3:1，第三台為備援',
  'erp.example.edu.tw,10.0.0.41:80; 10.0.0.42:80,依Cookie固定,JSESSIONID,,是,否,50M,是,否,登入狀態固定在同一台',
].join('\r\n');
const IMP_STATUS = {
  new: { type: 'success', text: '新增' },
  exists: { type: 'warning', text: '網域已存在' },
  duplicate: { type: 'warning', text: '重複' },
  error: { type: 'danger', text: '錯誤' },
};
const impDlg = reactive({ visible: false, step: 'pick', loading: false, saving: false, fileName: '', rows: [], error: '' });
const dupDlg = reactive({ visible: false });
const impSummary = computed(() => {
  const r = impDlg.rows;
  return {
    total: r.length,
    error: r.filter((x) => x.status === 'error').length,
    duplicate: r.filter((x) => x.status === 'duplicate').length,
    create: r.filter((x) => x.action === 'create').length,
    update: r.filter((x) => x.action === 'update').length,
    skip: r.filter((x) => x.action === 'skip').length,
  };
});
const impDupRows = computed(() => impDlg.rows.filter((x) => x.status === 'duplicate'));

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const downloadTemplate = () => downloadBlob(new Blob(['\uFEFF' + IMPORT_TEMPLATE + '\r\n'], { type: 'text/csv;charset=utf-8' }), '網域規則匯入範本.csv');
async function exportRules() {
  try {
    const blob = await api.get('/rules/export.csv', { responseType: 'blob' });
    downloadBlob(blob, `domain-rules-${new Date().toISOString().slice(0, 10)}.csv`);
  } catch (e) { ElMessage.error(e.message); }
}

function openImport() {
  Object.assign(impDlg, { visible: true, step: 'pick', loading: false, saving: false, fileName: '', rows: [], error: '' });
}

/** Excel 在中文 Windows 另存的 CSV 多為 Big5：先試 UTF-8，失敗再用 Big5 解碼 */
function decodeText(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return new TextDecoder('big5').decode(buf); }
}

async function onImportFile(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (file.size > 900 * 1024) { impDlg.error = '檔案過大（上限約 900 KB / 500 筆）'; return; }
  impDlg.fileName = file.name;
  impDlg.error = '';
  impDlg.loading = true;
  try {
    const csv = decodeText(await file.arrayBuffer());
    const data = await api.post('/rules/import/preview', { csv });
    impDlg.rows = data.rows;
    impDlg.step = 'preview';
  } catch (err) {
    impDlg.error = err.message;
  } finally {
    impDlg.loading = false;
  }
}

/** 刪除列或調整動作後重新檢查（重複 / 衝突狀態可能因此改變） */
async function recheckImport() {
  if (!impDlg.rows.length) { impDlg.step = 'pick'; return; }
  impDlg.loading = true;
  try {
    const data = await api.post('/rules/import/preview', { rows: impDlg.rows });
    impDlg.rows = data.rows;
  } catch (err) {
    ElMessage.error(err.message);
  } finally {
    impDlg.loading = false;
  }
}

function removeImportRow(row) {
  impDlg.rows = impDlg.rows.filter((x) => x !== row);
  return recheckImport();
}

async function removeAllDuplicates() {
  impDlg.rows = impDlg.rows.filter((x) => x.status !== 'duplicate');
  dupDlg.visible = false;
  await recheckImport();
  if (impDlg.rows.length) await confirmImport(true);
}

/** 確認匯入：先處理重複，再做最後確認 */
async function confirmImport(skipDupCheck = false) {
  if (impSummary.value.error) return ElMessage.warning('請先刪除或修正有錯誤的列');
  if (!skipDupCheck && impDupRows.value.length) { dupDlg.visible = true; return undefined; }
  dupDlg.visible = false;
  const { create, update, skip } = impSummary.value;
  if (!create && !update) return ElMessage.warning('沒有需要新增或覆蓋的規則');
  try {
    await ElMessageBox.confirm(
      `將新增 ${create} 筆、覆蓋 ${update} 筆${skip ? `、略過 ${skip} 筆` : ''}。匯入後需按「一鍵同步部署」才會推送到 Nginx 節點，確定匯入？`,
      '確認匯入', { type: 'warning', confirmButtonText: '確定匯入', cancelButtonText: '取消' },
    );
  } catch { return undefined; }
  impDlg.saving = true;
  try {
    const r = await api.post('/rules/import', { rows: impDlg.rows });
    ElMessage.success(`匯入完成：新增 ${r.created} 筆、覆蓋 ${r.updated} 筆、略過 ${r.skipped} 筆（需按「一鍵同步部署」才會生效）`);
    impDlg.visible = false;
    await loadAll();
  } catch (err) {
    ElMessage.error(err.message);
    await recheckImport();
  } finally {
    impDlg.saving = false;
  }
  return undefined;
}

const probeRule = (row) => runProbe(`測試後端連線：${row.DomainName}`, () => api.post(`/rules/${row.Id}/test-backends`));
const probeForm = () => runProbe(`測試後端連線：${ruleDlg.form.DomainName || '（未儲存的規則）'}`,
  () => api.post('/rules/test-backends', { Upstreams: ruleDlg.form.Upstreams.map((u) => ({ ...u, Host: String(u.Host || '').trim() })) }));

async function removeRule(row) {
  try {
    await ElMessageBox.confirm(`確定刪除規則「${row.DomainName}」？`, '刪除確認', { type: 'warning' });
  } catch { return; }
  try {
    await api.delete(`/rules/${row.Id}`);
    if (ruleDlg.id === row.Id) ruleDlg.visible = false;
    ElMessage.success('已刪除');
    await loadAll();
  } catch (e) { ElMessage.error(e.message); }
}

const previewDlg = reactive({ visible: false, title: '', text: '' });
async function previewRule(row) {
  try {
    previewDlg.text = await api.get(`/rules/${row.Id}/preview`, { transformResponse: (d) => d });
    previewDlg.title = `${row.DomainName} 設定檔預覽`;
    previewDlg.visible = true;
  } catch (e) { ElMessage.error(e.message); }
}

/* ------------------------------------------------------------------ 憑證上傳 / 續約 / 刪除 */
const certDlg = reactive({
  visible: false, id: null, saving: false, mode: 'pem',
  alias: '', pfxPassword: '', cert: null, key: null, pfx: null,
});

function openCert(row) {
  Object.assign(certDlg, {
    visible: true, id: row ? row.Id : null, mode: 'pem',
    alias: row ? row.Alias : '', pfxPassword: '', cert: null, key: null, pfx: null,
  });
}

const pickFile = (field, e) => { certDlg[field] = e.target.files[0] || null; };

async function saveCert() {
  if (!certDlg.id && !certDlg.alias.trim()) return ElMessage.warning('請輸入憑證別名');
  if (certDlg.mode === 'pem' && (!certDlg.cert || !certDlg.key)) return ElMessage.warning('請選擇 .crt 與 .key 檔案');
  if (certDlg.mode === 'pfx' && !certDlg.pfx) return ElMessage.warning('請選擇 .pfx 檔案');
  const fd = new FormData();
  fd.append('alias', certDlg.alias);
  fd.append('mode', certDlg.mode);
  if (certDlg.mode === 'pem') {
    fd.append('cert', certDlg.cert);
    fd.append('key', certDlg.key);
  } else {
    fd.append('pfx', certDlg.pfx);
    fd.append('pfxPassword', certDlg.pfxPassword);
  }
  certDlg.saving = true;
  try {
    const res = certDlg.id ? await api.put(`/certificates/${certDlg.id}`, fd) : await api.post('/certificates', fd);
    ElMessage.success(`憑證已${certDlg.id ? '更新' : '匯入'}：到期日 ${fmt(res.ValidTo)}`);
    (res.warnings || []).forEach((w) => ElMessage({ type: 'warning', message: w, duration: 8000 }));
    certDlg.visible = false;
    await loadAll();
  } catch (e) {
    ElMessage({ type: 'error', message: e.message, duration: 8000, showClose: true });
  } finally { certDlg.saving = false; }
}

async function removeCert(row) {
  try {
    await ElMessageBox.confirm(`確定刪除憑證「${row.Alias}」？`, '刪除確認', { type: 'warning' });
  } catch { return; }
  try {
    await api.delete(`/certificates/${row.Id}`);
    ElMessage.success('已刪除');
    await loadAll();
  } catch (e) { ElMessage.error(e.message); }
}

/* ------------------------------------------------------------------ 一鍵同步部署 + 即時 Log */
const deployDlg = reactive({ visible: false, running: false, state: '', message: '', errorDetail: '', lines: [] });
const logBox = ref();
const deploying = computed(() => deployDlg.running);
let es = null;

function pushLine(entry) {
  deployDlg.lines.push(entry);
  nextTick(() => { if (logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight; });
}

async function startDeploy() {
  try {
    await ElMessageBox.confirm(
      '將把所有「啟用」的規則與憑證推送至所有啟用的 Nginx 節點；兩台皆通過 nginx -t 後才會 reload，任一失敗會自動回滾。確定執行？',
      '一鍵同步部署',
      { type: 'warning', confirmButtonText: '開始部署', cancelButtonText: '取消' },
    );
  } catch { return; }

  Object.assign(deployDlg, { visible: true, running: true, state: 'running', message: '部署中…', errorDetail: '', lines: [] });

  // 先建立 SSE 連線，再送出部署，確保不漏掉前幾行 Log
  es = new EventSource(eventsUrl());
  es.onmessage = (ev) => { try { pushLine(JSON.parse(ev.data)); } catch { /* ignore */ } };
  await new Promise((resolve) => { es.onopen = resolve; setTimeout(resolve, 1500); });

  try {
    const res = await api.post('/deploy');
    deployDlg.state = 'success';
    deployDlg.message = res.message;
  } catch (e) {
    const d = e.data || {};
    deployDlg.state = d.status === 'PARTIAL' || d.status === 'ROLLED_BACK' ? 'warning' : 'failed';
    deployDlg.message = d.message || e.message;
    deployDlg.errorDetail = d.errorDetail || '';
  } finally {
    deployDlg.running = false;
    setTimeout(() => { if (es) { es.close(); es = null; } }, 800);
    await loadAll();
  }
}

function closeDeploy() {
  if (deployDlg.running) return ElMessage.info('部署進行中，請等待完成');
  deployDlg.visible = false;
  return undefined;
}

onBeforeUnmount(() => { if (es) es.close(); if (backendTimer) clearInterval(backendTimer); stopNodeLogTimer(); });

/* ------------------------------------------------------------------ 節點 Nginx Log */
const NODE_LOG_LINES = [100, 200, 500, 1000, 2000];
const nodeLogDlg = reactive({
  visible: false, node: null, type: 'access', lines: 200, q: '', domain: '',
  loading: false, data: null, error: '', hint: '', auto: false, newestFirst: true,
});
let nodeLogTimer = null;
function stopNodeLogTimer() { if (nodeLogTimer) { clearInterval(nodeLogTimer); nodeLogTimer = null; } }
function openNodeLog(node) {
  Object.assign(nodeLogDlg, { visible: true, node, data: null, error: '', hint: '', auto: false });
  loadNodeLog();
}
async function loadNodeLog() {
  if (!nodeLogDlg.node || nodeLogDlg.loading) return;
  nodeLogDlg.loading = true;
  try {
    const { type, lines, q, domain } = nodeLogDlg;
    const params = { type, lines, q: q.trim() || undefined, domain: type === 'waf' && domain ? domain : undefined };
    nodeLogDlg.data = await api.get(`/nodes/${nodeLogDlg.node.Id}/logs`, { params });
    nodeLogDlg.error = '';
    nodeLogDlg.hint = '';
  } catch (e) {
    nodeLogDlg.error = e.message;
    nodeLogDlg.hint = e.data?.hint || '';
    nodeLogDlg.auto = false;
    stopNodeLogTimer();
  } finally { nodeLogDlg.loading = false; }
}
function toggleNodeLogAuto(on) {
  stopNodeLogTimer();
  if (on) nodeLogTimer = setInterval(loadNodeLog, 5000);
}
/** 依內容標示顏色：access.log 看狀態碼，error.log 看等級 */
function nodeLogClass(line) {
  // WAF：被阻擋（Access denied）紅色、偵測到（Warning）橘色
  if (nodeLogDlg.type === 'waf') return /Access denied/.test(line) ? 'error' : 'warn';
  if (nodeLogDlg.type === 'error') {
    if (/\[(emerg|alert|crit|error)\]/.test(line)) return 'error';
    if (/\[warn\]/.test(line)) return 'warn';
    return '';
  }
  const m = line.match(/" (\d{3}) /);
  if (!m) return '';
  if (m[1] >= '500') return 'error';
  if (m[1] >= '400') return 'warn';
  return '';
}
/** WAF Log 的網域選項：已設定 WAF（僅偵測 / 阻擋）的網域排前面，其餘網域也可選（可查曾開過 WAF 的舊紀錄） */
const wafLogDomains = computed(() => {
  const list = rules.value.map((r) => ({ name: r.DomainName, on: (r.WafMode || 'off') !== 'off' }));
  return list.sort((a, b) => (b.on - a.on) || a.name.localeCompare(b.name));
});
const nodeLogLines = computed(() => {
  const l = nodeLogDlg.data?.lines || [];
  return nodeLogDlg.newestFirst ? [...l].reverse() : l;
});

/* ------------------------------------------------------------------ 部署紀錄詳情 */
const logDlg = reactive({ visible: false, data: null });
async function showLog(row) {
  try {
    logDlg.data = await api.get(`/deploy/logs/${row.Id}`);
    logDlg.visible = true;
  } catch (e) { ElMessage.error(e.message); }
}

onMounted(() => {
  loadAll();
  loadCutoverCfg();
  // 每 30 秒讀一次後端燈號（只讀伺服器記憶體中的結果，負擔極小）
  backendTimer = setInterval(loadBackendStatus, 30000);
});
</script>

<template>
  <div class="page" v-loading="loading">
    <!-- 標題列 -->
    <header class="topbar">
      <div>
        <h1>Nginx HA Proxy Manager</h1>
        <div class="sub">反向代理伺服器節點管理系統</div>
      </div>
      <div class="actions">
        <el-tag v-if="pendingChanges" type="warning" effect="light" round>有尚未部署的變更</el-tag>
        <el-button type="primary" size="large" :icon="Upload" :loading="deploying" @click="startDeploy">
          一鍵同步部署
        </el-button>
        <span class="user">{{ session.username }}</span>
        <el-button :icon="SwitchButton" circle title="登出" @click="logout" />
      </div>
    </header>

    <!-- 節點狀態燈號 -->
    <section class="nodes">
      <el-card v-for="n in nodes" :key="n.Id" shadow="never" class="node-card" :class="{ inactive: !n.IsActive }">
        <div class="node-row">
          <span class="light" :class="lightClass(n)" :title="n.HealthMessage || ''" />
          <div class="node-info">
            <div class="node-name">{{ n.NodeName }}</div>
            <div class="node-meta">{{ n.IpAddress }}:{{ n.SshPort }} · {{ n.IsActive ? HEALTH_TEXT[n.HealthStatus] : '已停用' }}</div>
            <div class="node-meta">最後同步：{{ fmt(n.LastSyncAt) }}</div>
            <div v-if="n.IsActive && nodeVer(n)" class="node-meta" :title="nodeVer(n).os || ''">
              {{ nodeVer(n).os || 'OS ?' }} · nginx {{ nodeVer(n).nginx || '?' }}
            </div>
            <div v-if="n.IsActive && nodeWaf(n)" class="node-meta">
              <span :class="nodeWaf(n).ready ? 'waf-ok' : 'waf-miss'">
                WAF：{{ nodeWaf(n).ready ? wafVerText(n) : '模組未安裝' }}
              </span>
            </div>
          </div>
          <el-switch :model-value="n.IsActive" size="small" @change="(v) => toggleNode(n, v)" />
          <el-button size="small" :icon="Document" circle text title="檢視 Nginx Log" @click="openNodeLog(n)" />
          <el-button size="small" :icon="Edit" circle text title="編輯節點" @click="openNode(n)" />
        </div>
        <template v-if="n.IsActive && n.Stats">
          <div v-if="n.Stats.error" class="res-err">{{ n.Stats.error }}</div>
          <div v-else class="res" :title="'更新於 ' + fmt(n.Stats.at)">
            <div v-for="r in resRows(n.Stats)" :key="r.label" class="res-row" :title="r.tip">
              <span class="res-label">{{ r.label }}</span>
              <el-progress :percentage="Math.min(100, r.p || 0)" :color="usageColor(r.p || 0)" :stroke-width="8" :show-text="false" class="res-bar" />
              <span class="res-val">{{ r.text }}</span>
            </div>
          </div>
        </template>
      </el-card>
      <div class="node-tools">
        <el-button :icon="Refresh" :loading="checking" circle title="重新檢測節點連線" @click="checkNodes" />
        <el-button :icon="Plus" circle title="新增節點" @click="openNode(null)" />
      </div>
    </section>

    <el-tabs v-model="tab" class="tabs" @tab-change="onTabChange">
      <!-- ============ 網域規則 ============ -->
      <el-tab-pane label="網域對照規則" name="rules">
        <div class="toolbar">
          <el-button type="primary" :icon="Plus" @click="openRule(null)">新增規則</el-button>
          <el-button :icon="Upload" @click="openImport">匯入</el-button>
          <el-button :icon="Download" @click="exportRules">匯出</el-button>
          <el-button :icon="Aim" :disabled="!ruleSelection.length || !cutoverCfg.enabled"
                     :title="cutoverCfg.enabled ? `模擬 DNS 改指 ${cutoverCfg.vip} 後的連線結果（唯讀）` : '尚未設定 CUTOVER_VIP'"
                     @click="runCutoverCheck(ruleSelection)">
            切換前檢查{{ ruleSelection.length ? `（${ruleSelection.length}）` : '' }}
          </el-button>
          <span class="hint">修改後需按右上角「一鍵同步部署」才會推送到 Nginx 節點。</span>
        </div>
        <div class="toolbar search-bar">
          <el-input v-model="ruleQuery" :prefix-icon="Search" clearable placeholder="搜尋網域或後端 IP" class="search" />
          <!-- 表格右上角：目前筆數（搜尋時顯示符合 / 全部） -->
          <span class="row-count">
            <template v-if="ruleQuery">找到 <b>{{ filteredRules.length }}</b> / {{ rules.length }} 筆</template>
            <template v-else>共 <b>{{ rules.length }}</b> 筆</template>
          </span>
        </div>
        <el-table :data="filteredRules" stripe border style="width: 100%" :empty-text="ruleQuery ? '查無符合的規則' : '尚無規則'"
                  row-key="Id" @selection-change="(v) => (ruleSelection = v)">
          <el-table-column type="selection" width="42" fixed align="center" />
          <el-table-column prop="DomainName" label="來源網域" min-width="200" fixed>
            <template #default="{ row }">
              <!-- 萬用字元網域（*.xxx）無法直接開啟，只顯示文字 -->
              <span v-if="row.DomainName.startsWith('*.')">{{ row.DomainName }}</span>
              <a v-else class="domain-link" :href="siteUrl(row)" target="_blank" rel="noopener noreferrer"
                 :title="`另開視窗：${siteUrl(row)}`">{{ row.DomainName }}</a>
            </template>
          </el-table-column>
          <el-table-column label="後端目標" min-width="200">
            <template #default="{ row }">
              <div class="ups">
                <div v-for="(u, i) in ruleUpstreams(row)" :key="i" class="ups-item" :class="{ off: !u.IsActive }">
                  <span class="dot" :class="backendLight(u).cls" :title="backendLight(u).tip" />
                  {{ u.Host }}:{{ u.Port }}
                  <el-tag v-if="u.Weight > 1" size="small" type="info">×{{ u.Weight }}</el-tag>
                  <el-tag v-if="u.IsBackup" size="small" type="warning">備援</el-tag>
                  <el-tag v-if="!u.IsActive" size="small" type="info">停用</el-tag>
                </div>
                <el-tag v-if="ruleUpstreams(row).length > 1 || row.LbMethod !== 'round_robin'" size="small" effect="plain" class="ups-method">
                  {{ (LB_METHOD[row.LbMethod] || {}).text || row.LbMethod }}{{ row.LbMethod === 'cookie' ? `：${row.LbCookieName}` : '' }}
                </el-tag>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="SSL 憑證" min-width="230">
            <template #default="{ row }">
              <div v-if="row.certificate" class="cert-cell">
                <span class="ellipsis">{{ row.certificate.Alias }}</span>
                <el-tag size="small" :type="certTag(row.certificate.ValidTo).type">{{ certTag(row.certificate.ValidTo).text }}</el-tag>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="強制 HTTPS" width="100" align="center">
            <template #default="{ row }"><el-tag size="small" :type="row.ForceHttps ? 'success' : 'info'">{{ row.ForceHttps ? '是' : '否' }}</el-tag></template>
          </el-table-column>
          <el-table-column label="WebSocket" width="100" align="center">
            <template #default="{ row }"><el-tag size="small" :type="row.EnableWebSocket ? 'success' : 'info'">{{ row.EnableWebSocket ? '支援' : '否' }}</el-tag></template>
          </el-table-column>
          <el-table-column prop="ClientMaxBodySize" label="上傳上限" width="90" align="center" />
          <el-table-column label="WAF" width="90" align="center">
            <template #default="{ row }">
              <el-tooltip :content="wafTag(row).tip" :disabled="!wafTag(row).tip" placement="top">
                <el-tag size="small" :type="wafTag(row).type" :effect="(row.WafMode || 'off') !== 'off' && wafCfg.Enabled ? 'dark' : 'light'">{{ wafTag(row).text }}</el-tag>
              </el-tooltip>
            </template>
          </el-table-column>
          <el-table-column label="啟用" width="80" align="center">
            <template #default="{ row }"><el-switch :model-value="row.IsActive" size="small" @change="(v) => quickToggle(row, 'IsActive', v)" /></template>
          </el-table-column>
          <el-table-column label="維護中頁面" width="110" align="center">
            <template #default="{ row }"><el-switch :model-value="row.IsMaintenance" size="small" active-color="#e6a23c" @change="(v) => quickToggle(row, 'IsMaintenance', v)" /></template>
          </el-table-column>
          <el-table-column prop="Remark" label="備註" min-width="160" show-overflow-tooltip />
          <el-table-column prop="CreatedAt" label="建立日期" width="170" align="center" sortable>
            <template #default="{ row }"><span class="date-cell">{{ fmt(row.CreatedAt) }}</span></template>
          </el-table-column>
          <el-table-column prop="UpdatedAt" label="最後更動" width="170" align="center" sortable>
            <template #default="{ row }">
              <span class="date-cell">{{ fmt(row.UpdatedAt) }}</span>
              <div class="idle-days" :class="{ long: idleDays(row.UpdatedAt) >= 180 }">{{ idleText(row.UpdatedAt) }}</div>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="210" fixed="right" align="center">
            <template #default="{ row }">
              <el-button size="small" :icon="Aim" circle :disabled="!cutoverCfg.enabled"
                         :title="cutoverCfg.enabled ? `切換前檢查：模擬 DNS 改指 ${cutoverCfg.vip}` : '切換前檢查（尚未設定 CUTOVER_VIP）'"
                         @click="runCutoverCheck([row])" />
              <el-button size="small" :icon="Connection" circle title="從節點測試後端連線" @click="probeRule(row)" />
              <el-button size="small" :icon="View" circle title="預覽 Nginx 設定" @click="previewRule(row)" />
              <el-button size="small" :icon="Edit" circle title="編輯（刪除也在編輯視窗內）" @click="openRule(row)" />
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <!-- ============ 憑證 ============ -->
      <el-tab-pane label="SSL 憑證庫" name="certs">
        <div class="toolbar">
          <el-button type="primary" :icon="UploadFilled" @click="openCert(null)">上傳憑證</el-button>
          <span class="hint">到期前 30 天以橘色、14 天內以紅色提醒。</span>
        </div>
        <el-table :data="certs" stripe border style="width: 100%" empty-text="尚無憑證">
          <el-table-column prop="Alias" label="別名" min-width="220" fixed />
          <el-table-column prop="SanDomains" label="涵蓋網域 (SAN)" min-width="260" show-overflow-tooltip />
          <el-table-column prop="Issuer" label="發行商" min-width="180" show-overflow-tooltip />
          <el-table-column label="到期日" min-width="200">
            <template #default="{ row }">
              <div class="cert-cell">
                <span>{{ fmt(row.ValidTo) }}</span>
                <el-tag size="small" effect="dark" :type="certTag(row.ValidTo).type">{{ certTag(row.ValidTo).text }}</el-tag>
              </div>
            </template>
          </el-table-column>
          <el-table-column prop="RuleCount" label="使用中規則" width="100" align="center" />
          <el-table-column label="操作" width="170" fixed="right" align="center">
            <template #default="{ row }">
              <el-button size="small" @click="openCert(row)">更新憑證</el-button>
              <el-button size="small" type="danger" :icon="Delete" circle title="刪除" @click="removeCert(row)" />
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <!-- ============ Nginx 節點 ============ -->
      <el-tab-pane label="Nginx 節點" name="nodes">
        <div class="toolbar">
          <el-button type="primary" :icon="Plus" @click="openNode(null)">新增節點</el-button>
          <span class="hint">部署會推送到所有「啟用」的節點；修改 IP 後建議按上方重新檢測確認連線。</span>
        </div>
        <el-table :data="nodes" stripe border style="width: 100%" empty-text="尚無節點">
          <el-table-column prop="NodeName" label="節點名稱" min-width="150" fixed />
          <el-table-column label="IP / Port" min-width="170">
            <template #default="{ row }">{{ row.IpAddress }}:{{ row.SshPort }}</template>
          </el-table-column>
          <el-table-column prop="SshUser" label="SSH 帳號" width="110" />
          <el-table-column label="私鑰路徑" min-width="200" show-overflow-tooltip>
            <template #default="{ row }">{{ row.SshKeyPath || '（使用 .env 預設）' }}</template>
          </el-table-column>
          <el-table-column label="主機指紋" width="110" align="center">
            <template #default="{ row }">
              <el-tag v-if="row.HostKeySha256" size="small" type="success" :title="row.HostKeySha256">已設定</el-tag>
              <el-tag v-else size="small" type="warning">未驗證</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="狀態" min-width="170">
            <template #default="{ row }">
              <span class="light sm" :class="lightClass(row)" />
              {{ row.IsActive ? HEALTH_TEXT[row.HealthStatus] : '已停用' }}
            </template>
          </el-table-column>
          <el-table-column label="啟用" width="80" align="center">
            <template #default="{ row }"><el-switch :model-value="row.IsActive" size="small" @change="(v) => toggleNode(row, v)" /></template>
          </el-table-column>
          <el-table-column label="操作" width="150" fixed="right" align="center">
            <template #default="{ row }">
              <el-button size="small" :icon="Document" circle title="檢視 Nginx Log" @click="openNodeLog(row)" />
              <el-button size="small" :icon="Edit" circle title="編輯" @click="openNode(row)" />
              <el-button size="small" type="danger" :icon="Delete" circle title="刪除" @click="removeNode(row)" />
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <!-- ============ WAF 防護 ============ -->
      <el-tab-pane name="waf">
        <template #label><span class="tab-label"><el-icon><Lock /></el-icon>WAF 防護</span></template>
        <div class="waf-page">
          <el-alert v-if="wafCfg.missingTable" type="error" :closable="false" show-icon
                    title="資料庫尚未建立 WAF 資料表，請先執行 database/schema.sql" />
          <el-alert v-if="wafNodesMissing.length" type="warning" :closable="false" show-icon
                    :title="`${wafNodesMissing.map((n) => n.NodeName).join('、')} 尚未安裝 WAF 模組，開啟 WAF 的網域將無法部署`"
                    description="請依操作手冊「WAF 模組安裝」以 sysadmin 在節點執行安裝指令（只安裝不啟用，不影響網站）。" />
          <el-card shadow="never" class="waf-card">
            <template #header><b>全域設定</b><span class="hint">ModSecurity v3 + OWASP 核心規則集（CRS），在 Nginx 解開 SSL 後檢查請求</span></template>
            <el-form label-width="120px" class="waf-form">
              <el-form-item label="WAF 總開關">
                <el-switch v-model="wafForm.Enabled" active-text="開啟" inactive-text="關閉" />
                <div class="form-hint">關閉時所有網域都不檢查，部署出去的設定與未導入 WAF 前完全相同。各網域在「網域對照規則」的編輯視窗設定 關閉 / 僅偵測 / 阻擋。</div>
              </el-form-item>
              <el-form-item label="嚴格程度">
                <el-radio-group v-model="wafForm.ParanoiaLevel">
                  <el-radio-button v-for="p in PARANOIA" :key="p.v" :value="p.v">{{ p.text }}</el-radio-button>
                </el-radio-group>
                <div class="form-hint">{{ PARANOIA.find((p) => p.v === wafForm.ParanoiaLevel)?.hint }}</div>
              </el-form-item>
              <el-form-item label="阻擋門檻分數">
                <el-input-number v-model="wafForm.InboundThreshold" :min="1" :max="100" :step="1" />
                <div class="form-hint">每條命中的規則會累加分數（嚴重 5 分、錯誤 4 分、警告 3 分），達到門檻即判定為攻擊。預設 5，數字越大越寬鬆。</div>
              </el-form-item>
              <el-form-item>
                <el-button type="primary" :loading="wafSaving" :disabled="!wafDirty" @click="saveWaf">儲存設定</el-button>
                <span v-if="wafCfg.UpdatedAt && wafCfg.UpdatedBy" class="hint">最後修改：{{ fmt(wafCfg.UpdatedAt) }}（{{ wafCfg.UpdatedBy }}）</span>
              </el-form-item>
            </el-form>
          </el-card>
          <el-card shadow="never" class="waf-card">
            <template #header><b>目前狀態</b></template>
            <el-descriptions :column="1" border size="small">
              <el-descriptions-item label="總開關">
                <el-tag :type="wafCfg.Enabled ? 'success' : 'info'">{{ wafCfg.Enabled ? '開啟' : '關閉' }}</el-tag>
              </el-descriptions-item>
              <el-descriptions-item label="網域設定">
                僅偵測 <b>{{ wafCfg.ruleCounts?.detect || 0 }}</b> 個、阻擋 <b>{{ wafCfg.ruleCounts?.block || 0 }}</b> 個（只計啟用中的規則）
              </el-descriptions-item>
              <el-descriptions-item v-for="n in nodes.filter((x) => x.IsActive)" :key="n.Id" :label="n.NodeName">
                <template v-if="nodeWaf(n)">
                  <el-tag :type="nodeWaf(n).ready ? 'success' : 'danger'" size="small">{{ nodeWaf(n).ready ? '模組已安裝' : '模組未安裝' }}</el-tag>
                  <span v-if="nodeWaf(n).crsVersion" class="hint">OWASP CRS {{ nodeWaf(n).crsVersion }}</span>
                </template>
                <span v-else class="hint">尚未檢測（按節點旁的重新整理）</span>
              </el-descriptions-item>
            </el-descriptions>
            <div class="form-hint" style="margin-top: 10px">
              建議導入順序：總開關開啟 → 網域先設「僅偵測」並部署 → 觀察 1–2 週，在「檢視 Nginx Log」→「WAF 事件」選該網域找出誤判（兩台節點都要看），把規則 ID 加入排除 → 再改「阻擋」。
            </div>
          </el-card>
        </div>
      </el-tab-pane>

      <!-- ============ 部署紀錄 ============ -->
      <el-tab-pane label="部署紀錄" name="logs">
        <el-table :data="logs" stripe border style="width: 100%" empty-text="尚無部署紀錄">
          <el-table-column prop="Id" label="#" width="70" />
          <el-table-column label="開始時間" min-width="170"><template #default="{ row }">{{ fmt(row.StartedAt) }}</template></el-table-column>
          <el-table-column label="結束時間" min-width="170"><template #default="{ row }">{{ fmt(row.FinishedAt) }}</template></el-table-column>
          <el-table-column prop="TriggeredBy" label="操作者" width="110" />
          <el-table-column label="結果" width="110" align="center">
            <template #default="{ row }"><el-tag :type="(STATUS_TAG[row.Status] || {}).type">{{ (STATUS_TAG[row.Status] || {}).text || row.Status }}</el-tag></template>
          </el-table-column>
          <el-table-column prop="ErrorDetail" label="錯誤訊息" min-width="260" show-overflow-tooltip />
          <el-table-column label="操作" width="90" align="center">
            <template #default="{ row }"><el-button size="small" @click="showLog(row)">詳情</el-button></template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <!-- ============ 帳號管理 ============ -->
      <el-tab-pane label="帳號管理" name="accounts">
        <div class="toolbar">
          <el-button type="primary" :icon="Plus" @click="openAccount(null)">新增帳號</el-button>
          <span class="hint">可登入名單 = 下列啟用中的帳號（含 .env 的 ADMIN_ACCOUNTS）；登入時一律以 SOAP 驗證密碼，本系統不保存密碼。</span>
        </div>
        <el-table v-loading="accountsLoading" :data="accounts" stripe border style="width: 100%" empty-text="尚無帳號">
          <el-table-column prop="Username" label="帳號" min-width="140" />
          <el-table-column prop="DisplayName" label="姓名 / 單位" min-width="140" />
          <el-table-column label="來源" width="120" align="center">
            <template #default="{ row }">
              <el-tag v-if="row.Source === 'env'" type="warning">.env 特權</el-tag>
              <el-tag v-else-if="row.DuplicateOfEnv" type="info" title="此帳號也在 .env 中，以 .env 為準">帳號管理（重複）</el-tag>
              <el-tag v-else>帳號管理</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="啟用" width="80" align="center">
            <template #default="{ row }">
              <el-switch v-if="row.Source === 'db'" :model-value="row.IsActive" @change="(v) => toggleAccount(row, v)" />
              <el-switch v-else :model-value="true" disabled title="請至 backend/.env 修改" />
            </template>
          </el-table-column>
          <el-table-column label="最後登入" width="170"><template #default="{ row }">{{ fmt(row.LastLoginAt) }}</template></el-table-column>
          <el-table-column prop="CreatedBy" label="建立者" width="110" />
          <el-table-column prop="Remark" label="備註" min-width="200" show-overflow-tooltip />
          <el-table-column label="操作" width="110" fixed="right" align="center">
            <template #default="{ row }">
              <template v-if="row.Source === 'db'">
                <el-button size="small" :icon="Edit" circle title="編輯" @click="openAccount(row)" />
                <el-button size="small" type="danger" :icon="Delete" circle title="刪除" @click="removeAccount(row)" />
              </template>
              <span v-else class="hint">唯讀</span>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <!-- ============ 操作紀錄 ============ -->
      <el-tab-pane label="操作紀錄" name="audit">
        <div class="toolbar">
          <el-input v-model="audit.q" :prefix-icon="Search" clearable placeholder="帳號、對象（網域 / 別名 / 節點）、IP、內容" class="search wide" @keyup.enter="loadAudit(true)" @clear="loadAudit(true)" />
          <el-select v-model="audit.action" clearable placeholder="動作" class="sel" @change="loadAudit(true)">
            <el-option v-for="(v, k) in AUDIT_ACTION" :key="k" :value="k" :label="v.text" />
          </el-select>
          <el-select v-model="audit.targetType" clearable placeholder="類別" class="sel" @change="loadAudit(true)">
            <el-option v-for="(v, k) in AUDIT_TARGET" :key="k" :value="k" :label="v" />
          </el-select>
          <el-date-picker v-model="audit.range" type="daterange" range-separator="至" start-placeholder="開始日期" end-placeholder="結束日期" class="range" @change="loadAudit(true)" />
          <el-button type="primary" :icon="Search" @click="loadAudit(true)">查詢</el-button>
        </div>
        <el-table v-loading="audit.loading" :data="audit.rows" stripe border style="width: 100%" empty-text="尚無操作紀錄">
          <el-table-column label="時間" width="170"><template #default="{ row }">{{ fmt(row.CreatedAt) }}</template></el-table-column>
          <el-table-column prop="Username" label="帳號" width="110" />
          <el-table-column prop="ClientIp" label="來源 IP" width="130" />
          <el-table-column label="動作" width="100" align="center">
            <template #default="{ row }">
              <el-tag :type="(AUDIT_ACTION[row.Action] || {}).type" :effect="row.Success ? 'light' : 'dark'">{{ (AUDIT_ACTION[row.Action] || {}).text || row.Action }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="類別" width="100"><template #default="{ row }">{{ AUDIT_TARGET[row.TargetType] || row.TargetType }}</template></el-table-column>
          <el-table-column prop="TargetName" label="對象" min-width="200" show-overflow-tooltip />
          <el-table-column label="結果" width="80" align="center">
            <template #default="{ row }"><el-tag :type="row.Success ? 'success' : 'danger'" size="small">{{ row.Success ? '成功' : '失敗' }}</el-tag></template>
          </el-table-column>
          <el-table-column label="內容" min-width="280">
            <template #default="{ row }"><div class="audit-detail">{{ auditDetail(row.Detail) }}</div></template>
          </el-table-column>
        </el-table>
        <el-pagination v-model:current-page="audit.page" v-model:page-size="audit.pageSize" :total="audit.total" :page-sizes="[20, 50, 100, 200]"
          layout="total, sizes, prev, pager, next" background class="pager" @current-change="loadAudit()" @size-change="loadAudit(true)" />
      </el-tab-pane>
    </el-tabs>

    <!-- 規則匯入 -->
    <el-dialog v-model="impDlg.visible" title="匯入網域對照規則" :width="impDlg.step === 'preview' ? '1100px' : '620px'" top="5vh" class="rwd-dialog" :close-on-click-modal="false">
      <div v-loading="impDlg.loading" element-loading-text="檢查中…">
        <!-- 步驟 1：選檔 -->
        <template v-if="impDlg.step === 'pick'">
          <el-alert type="info" :closable="false" show-icon title="匯入流程：選擇 CSV 檔 → 檢查格式與重複 → 確認後才寫入（寫入後仍需「一鍵同步部署」）" />
          <div class="imp-pick">
            <label class="imp-file">
              <input type="file" accept=".csv,.txt,text/csv" @change="onImportFile">
              <el-icon :size="36"><UploadFilled /></el-icon>
              <div>點這裡選擇 CSV 檔</div>
              <div class="hint">UTF-8 或 Excel 另存的 CSV（Big5）皆可，最多 500 筆</div>
            </label>
            <el-alert v-if="impDlg.error" type="error" :closable="false" show-icon :title="impDlg.error" />
          </div>
          <div class="imp-help">
            <div class="imp-help-title"><el-icon><Document /></el-icon> 欄位說明（第一列為標題）
              <el-button size="small" text type="primary" :icon="Download" @click="downloadTemplate">下載範本</el-button>
              <el-button size="small" text type="primary" :icon="Download" @click="exportRules">匯出目前規則</el-button>
            </div>
            <ul>
              <li><b>來源網域</b>、<b>後端主機</b> 必填；後端多台以 <code>;</code> 分隔：<code>10.0.0.21:8080</code>、權重 <code>10.0.0.22:8080*3</code>、備援 <code>10.0.0.23:8080(備援)</code>、停用 <code>(停用)</code></li>
              <li><b>分配方式</b>：輪流 / 最少連線 / 依Cookie固定（需填 <b>Cookie名稱</b>）；空白 = 輪流</li>
              <li><b>SSL憑證</b>：憑證別名；空白會自動選涵蓋該網域、到期日最晚的憑證</li>
              <li><b>強制HTTPS、WebSocket、啟用、維護中</b>：是 / 否；<b>上傳上限</b>：例 50M；<b>備註</b></li>
              <li>空白欄位：新增時用預設值，覆蓋既有規則時保留原值；自訂 Nginx 語法不會被匯入覆蓋</li>
              <li><b>重複</b> = 與既有規則或檔案中其他列「網域相同且後端 IP:Port 相同」，匯入前會提示，可刪除</li>
            </ul>
          </div>
        </template>

        <!-- 步驟 2：預覽與確認 -->
        <template v-else>
          <div class="imp-summary">
            <span>檔案：<b>{{ impDlg.fileName }}</b>，共 {{ impSummary.total }} 列</span>
            <el-tag type="success">新增 {{ impSummary.create }}</el-tag>
            <el-tag type="warning">覆蓋 {{ impSummary.update }}</el-tag>
            <el-tag type="info">略過 {{ impSummary.skip }}</el-tag>
            <el-tag v-if="impSummary.duplicate" type="warning" effect="dark">重複 {{ impSummary.duplicate }}</el-tag>
            <el-tag v-if="impSummary.error" type="danger" effect="dark">錯誤 {{ impSummary.error }}</el-tag>
          </div>
          <el-alert v-if="impSummary.error" type="error" :closable="false" show-icon
                    :title="`有 ${impSummary.error} 列格式錯誤：請刪除這些列，或修正檔案後重新選擇，才能匯入`" />
          <el-alert v-else type="success" :closable="false" show-icon title="格式檢查通過，請確認下列內容後按「確認匯入」" />
          <el-table :data="impDlg.rows" border size="small" max-height="52vh" style="width: 100%; margin-top: 10px"
                    :row-class-name="({ row }) => 'imp-' + row.status">
            <el-table-column prop="line" label="列" width="52" align="center" />
            <el-table-column label="狀態" width="100" align="center">
              <template #default="{ row }"><el-tag size="small" :type="IMP_STATUS[row.status].type">{{ IMP_STATUS[row.status].text }}</el-tag></template>
            </el-table-column>
            <el-table-column prop="DomainName" label="來源網域" min-width="170" show-overflow-tooltip />
            <el-table-column label="後端主機" min-width="200">
              <template #default="{ row }">
                <div class="imp-backends">{{ row.BackendsText || '—' }}</div>
                <div v-if="row.existingBackends && row.status !== 'error'" class="hint">目前：{{ row.existingBackends }}</div>
              </template>
            </el-table-column>
            <el-table-column label="分配 / 憑證" min-width="150">
              <template #default="{ row }"><div>{{ row.LbText }}</div><div class="hint">{{ row.CertAlias || '—' }}</div></template>
            </el-table-column>
            <el-table-column label="動作" width="120" align="center">
              <template #default="{ row }">
                <el-select v-if="row.existingId && row.status !== 'error' && row.duplicateOf?.type !== 'file'" v-model="row.action" size="small">
                  <el-option value="update" label="覆蓋更新" />
                  <el-option value="skip" label="略過" />
                </el-select>
                <span v-else-if="row.action === 'create'">新增</span>
                <span v-else-if="row.action === 'skip'" class="hint">略過</span>
                <span v-else class="hint">—</span>
              </template>
            </el-table-column>
            <el-table-column label="檢查結果" min-width="260">
              <template #default="{ row }">
                <div v-for="(m, i) in row.errors" :key="'e' + i" class="imp-err">✖ {{ m }}</div>
                <div v-if="row.duplicateOf" class="imp-warn">⚠ {{ row.duplicateOf.text }}</div>
                <div v-if="row.status === 'exists'" class="imp-warn">⚠ 網域已存在（後端不同），請選擇覆蓋或略過</div>
                <div v-for="(m, i) in row.warnings" :key="'w' + i" class="imp-warn">⚠ {{ m }}</div>
                <span v-if="row.status === 'new' && !row.warnings.length" class="imp-ok">✔ 正確</span>
              </template>
            </el-table-column>
            <el-table-column label="" width="56" align="center" fixed="right">
              <template #default="{ row }"><el-button size="small" type="danger" :icon="Delete" circle text title="從匯入清單刪除此列" @click="removeImportRow(row)" /></template>
            </el-table-column>
          </el-table>
        </template>
      </div>
      <template #footer>
        <el-button v-if="impDlg.step === 'preview'" @click="impDlg.step = 'pick'; impDlg.rows = []">重新選擇檔案</el-button>
        <el-button @click="impDlg.visible = false">取消</el-button>
        <el-button v-if="impDlg.step === 'preview'" type="primary" :loading="impDlg.saving"
                   :disabled="impDlg.loading || !!impSummary.error || !(impSummary.create + impSummary.update)" @click="confirmImport()">確認匯入</el-button>
      </template>
    </el-dialog>

    <!-- 匯入前：重複提示 -->
    <el-dialog v-model="dupDlg.visible" title="發現重複的規則" width="680px" class="rwd-dialog" append-to-body>
      <el-alert type="warning" :closable="false" show-icon
                :title="`以下 ${impDupRows.length} 列與既有規則或檔案中其他列「網域相同且後端 IP:Port 相同」，可刪除後再匯入`" />
      <el-table :data="impDupRows" border size="small" style="width: 100%; margin-top: 10px" max-height="45vh">
        <el-table-column prop="line" label="列" width="52" align="center" />
        <el-table-column prop="DomainName" label="來源網域" min-width="160" />
        <el-table-column prop="BackendsText" label="後端主機" min-width="160" />
        <el-table-column label="重複對象" min-width="200"><template #default="{ row }"><span class="imp-warn">{{ row.duplicateOf.text }}</span></template></el-table-column>
        <el-table-column label="處理" width="90" align="center">
          <template #default="{ row }"><el-button size="small" type="danger" :icon="Delete" @click="removeImportRow(row)">刪除</el-button></template>
        </el-table-column>
      </el-table>
      <div class="form-hint">保留的重複列：與既有規則重複者依「動作」欄覆蓋更新其他欄位（例如備註）或略過；與檔案內其他列重複者一律略過。</div>
      <template #footer>
        <el-button @click="dupDlg.visible = false">返回檢查</el-button>
        <el-button type="danger" @click="removeAllDuplicates">刪除全部重複列並繼續</el-button>
        <el-button type="primary" @click="confirmImport(true)">保留並繼續匯入</el-button>
      </template>
    </el-dialog>

    <!-- 後端連線測試結果 -->
    <el-dialog v-model="probeDlg.visible" :title="probeDlg.title" width="720px" class="rwd-dialog" append-to-body>
      <div v-loading="probeDlg.loading" element-loading-text="從各節點測試中（每個後端最多 5 秒）…" class="probe-body">
        <el-alert v-if="probeDlg.error" type="error" :closable="false" show-icon :title="probeDlg.error" />
        <template v-else-if="!probeDlg.loading">
          <el-alert v-if="probeAllOk" type="success" :closable="false" show-icon title="所有節點都能連到所有後端" />
          <el-alert v-else type="warning" :closable="false" show-icon title="有後端連不上：使用者連線時會得到 502 / 504，請確認後端服務已啟動、防火牆已對兩台節點開放該 Port" />
          <el-alert v-for="n in probeDlg.nodes.filter((x) => x.error)" :key="'e' + n.nodeId" type="error" :closable="false" show-icon :title="`${n.nodeName}：${n.error}`" class="probe-err" />
          <el-table :data="probeDlg.targets" border style="width: 100%; margin-top: 12px">
            <el-table-column label="後端" min-width="170"><template #default="{ row }">{{ row.host }}:{{ row.port }}</template></el-table-column>
            <el-table-column v-for="n in probeDlg.nodes" :key="n.nodeId" :label="`${n.nodeName}（${n.ip}）`" min-width="200">
              <template #default="{ row }">
                <template v-if="probeCell(n, row)">
                  <el-tag :type="PROBE_TAG[probeCell(n, row).status]" :title="probeCell(n, row).message">{{ PROBE_TEXT[probeCell(n, row).status] }}</el-tag>
                  <span v-if="probeCell(n, row).ok" class="probe-meta">{{ probeCell(n, row).ms }} ms<template v-if="probeCell(n, row).http"> · HTTP {{ probeCell(n, row).http }}</template></span>
                  <div v-else class="probe-meta">{{ probeCell(n, row).message }}</div>
                </template>
                <span v-else class="hint">—</span>
              </template>
            </el-table-column>
          </el-table>
          <div class="form-hint">在每台啟用中的節點上測試 TCP 連線，連得上再以 HTTP 取狀態碼（僅供參考，後端只提供 HTTPS 時可能顯示 400）。部署時也會自動檢查並在即時 Log 提出警告。</div>
        </template>
      </div>
      <template #footer><el-button @click="probeDlg.visible = false">關閉</el-button></template>
    </el-dialog>

    <!-- 切換前檢查結果 -->
    <el-dialog v-model="cutDlg.visible" :title="`切換前檢查（模擬 DNS 改指 ${cutoverCfg.vip || 'VIP'}）`" width="960px" class="rwd-dialog" append-to-body>
      <div v-loading="cutDlg.loading" :element-loading-text="`檢查 ${cutDlg.count} 筆規則中，每個網域約需數秒…`" class="cut-body">
        <el-alert v-if="cutDlg.error" type="error" :closable="false" show-icon :title="cutDlg.error" />
        <template v-else-if="cutDlg.data">
          <div class="cut-summary">
            <el-radio-group v-model="cutDlg.filter" size="small">
              <el-radio-button value="all">全部 {{ cutDlg.data.results.length }}</el-radio-button>
              <el-radio-button value="pass">可以切換 {{ cutCount('pass') }}</el-radio-button>
              <el-radio-button value="warn">有警告 {{ cutCount('warn') }}</el-radio-button>
              <el-radio-button value="fail">不要切換 {{ cutCount('fail') }}</el-radio-button>
              <el-radio-button v-if="cutCount('skip')" value="skip">略過 {{ cutCount('skip') }}</el-radio-button>
            </el-radio-group>
            <span class="hint">檢查時間：{{ fmt(cutDlg.data.checkedAt) }}</span>
          </div>
          <el-table :data="cutResults" border style="width: 100%" row-key="domain">
            <el-table-column type="expand">
              <template #default="{ row }">
                <div class="cut-detail">
                  <template v-if="row.vip">
                    <div><b>經 VIP https</b>（{{ row.vip.https.length }} 次）：
                      <span v-for="(x, i) in row.vip.https" :key="i" class="cut-req">{{ x.status || x.error }}<small> · {{ x.size }} B · {{ x.ms }} ms</small></span>
                    </div>
                    <div v-if="row.vip.follow.length > 1"><b>轉址過程</b>：
                      <span v-for="(f, i) in row.vip.follow" :key="i">{{ i ? ' → ' : '' }}{{ f.status }} {{ f.url }}</span>
                    </div>
                    <div><b>經 VIP http</b>：{{ row.vip.http.status || row.vip.http.error }}<template v-if="row.vip.http.location"> → {{ row.vip.http.location }}</template></div>
                    <div v-if="row.vip.cert"><b>憑證</b>：{{ row.vip.cert.subject }}（到期 {{ row.vip.cert.validTo }}）
                      {{ row.vip.cert.matches ? '涵蓋此網域' : '不涵蓋此網域' }}、{{ row.vip.cert.trusted ? '憑證鏈有效' : row.vip.cert.trustError }}</div>
                  </template>
                  <div v-if="row.current"><b>現行路徑</b>（{{ row.current.scheme }}://{{ row.current.ip }}）：
                    {{ row.current.status || row.current.error }}<template v-if="row.current.finalStatus !== row.current.status"> → 最終 {{ row.current.finalStatus }}</template>，{{ row.current.size }} B</div>
                  <div v-if="row.nodes && row.nodes.length"><b>各節點直連</b>：
                    <span v-for="n in row.nodes" :key="n.node" class="cut-req">{{ n.node }}：{{ n.status || n.error }}{{ n.defaultSite ? '（404 預設頁）' : '' }}</span>
                  </div>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="網域" min-width="200">
              <template #default="{ row }"><span class="mono">{{ row.domain }}</span></template>
            </el-table-column>
            <el-table-column label="判定" width="100" align="center">
              <template #default="{ row }"><el-tag :type="CUT_VERDICT[row.verdict].type" effect="dark">{{ CUT_VERDICT[row.verdict].text }}</el-tag></template>
            </el-table-column>
            <el-table-column label="DNS 現況" min-width="170">
              <template #default="{ row }">
                <el-tag v-if="row.dns && row.dns.switched" size="small" type="success">已指向 VIP</el-tag>
                <span v-else class="mono small">{{ cutDnsText(row) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="經 VIP" min-width="130">
              <template #default="{ row }"><span class="mono small">{{ row.vip ? cutStatusText(row.vip.https) : '—' }}</span></template>
            </el-table-column>
            <el-table-column label="原因" min-width="300">
              <template #default="{ row }">
                <div v-if="!row.issues.length" class="cut-ok">全部檢查通過</div>
                <div v-for="(it, i) in row.issues" :key="i" class="cut-issue">
                  <el-tag size="small" :type="CUT_ISSUE[it.level]">{{ it.level === 'fail' ? '失敗' : it.level === 'warn' ? '警告' : '說明' }}</el-tag>
                  <span>{{ it.text }}</span>
                </div>
              </template>
            </el-table-column>
          </el-table>
          <div v-if="cutPassDomains.length" class="cut-pass">
            <span>可以切換、DNS 尚未改的網域（{{ cutPassDomains.length }}）：<span class="mono">{{ cutPassDomains.join('、') }}</span></span>
            <el-button size="small" @click="copyPassDomains">複製清單</el-button>
          </div>
          <el-alert type="info" :closable="false" show-icon class="cut-manual"
                    title="以下項目無法自動判斷，切換前請與系統管理者確認">
            <ul>
              <li>後端是否以「來源 IP」限制存取：切換後後端看到的是 Nginx 節點 IP，請改信任 X-Real-IP / X-Forwarded-For</li>
              <li>是否有超過「上傳上限」的檔案上傳（超過會出現 413）</li>
              <li>網頁中是否寫死 IP 或非 80 / 443 的網址、是否需要 WebSocket</li>
            </ul>
          </el-alert>
        </template>
      </div>
      <template #footer>
        <el-button @click="cutDlg.visible = false">關閉</el-button>
      </template>
    </el-dialog>

    <!-- 帳號編輯 -->
    <el-dialog v-model="accDlg.visible" :title="accDlg.id ? '編輯帳號' : '新增帳號'" width="480px" class="rwd-dialog">
      <el-form ref="accFormRef" :model="accDlg.form" :rules="accRules" label-width="100px">
        <el-form-item label="帳號" prop="Username">
          <el-input v-model="accDlg.form.Username" :disabled="!!accDlg.id" placeholder="與 SOAP 認證相同的帳號" />
        </el-form-item>
        <el-form-item label="姓名 / 單位"><el-input v-model="accDlg.form.DisplayName" maxlength="100" /></el-form-item>
        <el-form-item label="啟用"><el-switch v-model="accDlg.form.IsActive" /></el-form-item>
        <el-form-item label="備註"><el-input v-model="accDlg.form.Remark" type="textarea" :rows="2" maxlength="300" show-word-limit /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="accDlg.visible = false">取消</el-button>
        <el-button type="primary" :loading="accDlg.saving" @click="saveAccount">儲存</el-button>
      </template>
    </el-dialog>

    <!-- 規則編輯 -->
    <el-dialog v-model="ruleDlg.visible" :title="ruleDlg.id ? '編輯網域規則' : '新增網域規則'" width="680px" top="5vh" class="rwd-dialog">
      <el-form ref="ruleFormRef" :model="ruleDlg.form" :rules="ruleRules" label-width="130px" label-position="right">
        <el-form-item label="來源網域" prop="DomainName"><el-input v-model="ruleDlg.form.DomainName" placeholder="portal.aeust.edu.tw" /></el-form-item>
        <el-form-item label="後端主機" prop="Upstreams" required>
          <div class="ups-edit">
            <div class="ups-head"><span>IP / 主機名稱</span><span>Port</span><span>權重</span><span>備援</span><span>啟用</span><span /></div>
            <div v-for="(u, i) in ruleDlg.form.Upstreams" :key="i" class="ups-row">
              <el-input v-model="u.Host" placeholder="10.0.0.21" />
              <el-input-number v-model="u.Port" :min="1" :max="65535" controls-position="right" />
              <el-input-number v-model="u.Weight" :min="1" :max="100" controls-position="right" title="權重越大分到越多流量" />
              <el-checkbox v-model="u.IsBackup" :disabled="ruleDlg.form.LbMethod === 'cookie'" title="主要後端都失效時才使用" />
              <el-switch v-model="u.IsActive" size="small" title="停用 = 暫時下線維護" />
              <el-button :icon="Delete" circle text size="small" :disabled="ruleDlg.form.Upstreams.length <= 1" title="移除" @click="ruleDlg.form.Upstreams.splice(i, 1)" />
            </div>
            <div class="ups-actions">
              <el-button :icon="Plus" size="small" @click="ruleDlg.form.Upstreams.push(blankUpstream())">新增後端主機</el-button>
              <el-button :icon="Connection" size="small" @click="probeForm">從節點測試連線</el-button>
            </div>
          </div>
        </el-form-item>
        <el-form-item v-if="ruleDlg.form.Upstreams.length > 1 || ruleDlg.form.LbMethod !== 'round_robin'" label="分配方式">
          <el-radio-group v-model="ruleDlg.form.LbMethod" @change="(v) => v === 'cookie' && ruleDlg.form.Upstreams.forEach((u) => (u.IsBackup = false))">
            <el-radio-button v-for="(m, k) in LB_METHOD" :key="k" :value="k">{{ m.text }}</el-radio-button>
          </el-radio-group>
          <div class="form-hint">{{ LB_METHOD[ruleDlg.form.LbMethod].hint }}。單台失敗 3 次即暫停 10 秒，連線失敗或逾時自動改送下一台（不重送 POST）。</div>
        </el-form-item>
        <el-form-item v-if="ruleDlg.form.LbMethod === 'cookie'" label="Cookie 名稱" prop="LbCookieName">
          <el-input v-model="ruleDlg.form.LbCookieName" placeholder="例：JSESSIONID、PHPSESSID" style="width: 260px" />
        </el-form-item>
        <el-form-item label="SSL 憑證" prop="CertificateId">
          <el-select v-model="ruleDlg.form.CertificateId" placeholder="選擇憑證" style="width: 100%">
            <el-option v-for="c in certs" :key="c.Id" :value="c.Id" :label="c.Alias">
              <span>{{ c.Alias }}</span>
              <el-tag size="small" :type="certTag(c.ValidTo).type" style="margin-left: 8px">{{ certTag(c.ValidTo).text }}</el-tag>
            </el-option>
          </el-select>
        </el-form-item>
        <el-form-item label="功能開關">
          <el-checkbox v-model="ruleDlg.form.ForceHttps">強制轉址 HTTPS</el-checkbox>
          <el-checkbox v-model="ruleDlg.form.EnableWebSocket">支援 WebSocket</el-checkbox>
          <el-checkbox v-model="ruleDlg.form.IsActive">啟用</el-checkbox>
          <el-checkbox v-model="ruleDlg.form.IsMaintenance">系統維護中頁面</el-checkbox>
        </el-form-item>
        <el-form-item label="上傳檔案上限"><el-input v-model="ruleDlg.form.ClientMaxBodySize" placeholder="2M" style="width: 160px" /></el-form-item>
        <el-form-item label="WAF 防護">
          <el-radio-group v-model="ruleDlg.form.WafMode">
            <el-radio-button v-for="(m, k) in WAF_MODE" :key="k" :value="k">{{ m.text }}</el-radio-button>
          </el-radio-group>
          <div class="form-hint">
            {{ WAF_MODE[ruleDlg.form.WafMode].hint }}
            <template v-if="ruleDlg.form.WafMode !== 'off' && !wafCfg.Enabled"><br><b class="warn-text">WAF 總開關目前關閉，需到「WAF 防護」分頁開啟才會生效。</b></template>
          </div>
        </el-form-item>
        <el-form-item v-if="ruleDlg.form.WafMode !== 'off'" label="WAF 排除規則" prop="WafExcludeIds">
          <el-input v-model="ruleDlg.form.WafExcludeIds" placeholder="例：942100, 920350（只能填數字規則 ID，逗號分隔）" />
          <div class="form-hint">被誤擋時，把 WAF 事件中的規則 ID 填在這裡，這個網域就不再套用該規則。</div>
        </el-form-item>
        <el-form-item label="自訂 Nginx 語法">
          <el-input v-model="ruleDlg.form.CustomNginxSnippet" type="textarea" :rows="5" class="mono"
                    placeholder="插入 443 server 區塊，例如：&#10;proxy_buffering off;&#10;add_header X-Frame-Options SAMEORIGIN;" />
        </el-form-item>
        <el-form-item label="備註"><el-input v-model="ruleDlg.form.Remark" maxlength="500" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button v-if="ruleDlg.id" class="rule-del-btn" type="danger" plain :icon="Delete" :disabled="ruleDlg.saving"
                   @click="removeRule({ Id: ruleDlg.id, DomainName: ruleDlg.form.DomainName })">刪除此規則</el-button>
        <el-button @click="ruleDlg.visible = false">取消</el-button>
        <el-button type="primary" :loading="ruleDlg.saving" @click="saveRule">儲存</el-button>
      </template>
    </el-dialog>

    <!-- 節點編輯 -->
    <el-dialog v-model="nodeDlg.visible" :title="nodeDlg.id ? '編輯 Nginx 節點' : '新增 Nginx 節點'" width="640px" class="rwd-dialog">
      <el-form ref="nodeFormRef" :model="nodeDlg.form" :rules="nodeRules" label-width="120px">
        <el-form-item label="節點名稱" prop="NodeName">
          <el-input v-model="nodeDlg.form.NodeName" maxlength="100" placeholder="nginx-node1" />
        </el-form-item>
        <el-form-item label="IP / 主機名稱" prop="IpAddress">
          <el-input v-model="nodeDlg.form.IpAddress" placeholder="例：10.1.2.11" />
        </el-form-item>
        <el-form-item label="SSH Port">
          <el-input-number v-model="nodeDlg.form.SshPort" :min="1" :max="65535" controls-position="right" />
        </el-form-item>
        <el-form-item label="SSH 帳號" prop="SshUser">
          <el-input v-model="nodeDlg.form.SshUser" placeholder="deployer" style="width: 220px" />
        </el-form-item>
        <el-form-item label="私鑰路徑">
          <el-input v-model="nodeDlg.form.SshKeyPath" placeholder="留空則使用 .env 的 SSH_KEY_PATH" />
          <div class="form-hint">控制層主機上的路徑，例：C:/nginx-ha-manager/keys/deployer_ed25519</div>
        </el-form-item>
        <el-form-item label="主機金鑰指紋" prop="HostKeySha256">
          <div class="fp-row">
            <el-input v-model="nodeDlg.form.HostKeySha256" placeholder="SHA256:..." />
            <el-button :loading="nodeDlg.probing" @click="probeFingerprint">從主機讀取</el-button>
          </div>
          <div class="form-hint">防止中間人攻擊；讀取後請與主機上 ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub 的結果核對。留空則不驗證。</div>
        </el-form-item>
        <el-form-item label="啟用"><el-switch v-model="nodeDlg.form.IsActive" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="nodeDlg.visible = false">取消</el-button>
        <el-button type="primary" :loading="nodeDlg.saving" @click="saveNode">儲存</el-button>
      </template>
    </el-dialog>

    <!-- 設定檔預覽 -->
    <el-dialog v-model="previewDlg.visible" :title="previewDlg.title" width="760px" class="rwd-dialog">
      <pre class="code">{{ previewDlg.text }}</pre>
    </el-dialog>

    <!-- 憑證上傳 -->
    <el-dialog v-model="certDlg.visible" :title="certDlg.id ? '更新憑證（續約）' : '上傳 SSL 憑證'" width="560px" class="rwd-dialog" destroy-on-close>
      <el-form label-width="110px">
        <el-form-item :label="certDlg.id ? '別名（可不改）' : '憑證別名'">
          <el-input v-model="certDlg.alias" placeholder="*.aeust.edu.tw 萬用字元憑證" />
        </el-form-item>
        <el-form-item label="上傳模式">
          <el-radio-group v-model="certDlg.mode">
            <el-radio-button value="pem">.crt (Fullchain) + .key</el-radio-button>
            <el-radio-button value="pfx">.pfx (IIS 匯出)</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <template v-if="certDlg.mode === 'pem'">
          <el-form-item label="憑證檔"><input type="file" accept=".crt,.pem,.cer" @change="pickFile('cert', $event)"></el-form-item>
          <el-form-item label="私鑰檔"><input type="file" accept=".key,.pem" @change="pickFile('key', $event)"></el-form-item>
        </template>
        <template v-else>
          <el-form-item label="PFX 檔"><input type="file" accept=".pfx,.p12" @change="pickFile('pfx', $event)"></el-form-item>
          <el-form-item label="PFX 密碼"><el-input v-model="certDlg.pfxPassword" type="password" show-password autocomplete="new-password" /></el-form-item>
        </template>
        <el-alert type="info" :closable="false" show-icon
                  title="系統會自動解析到期日與 SAN，並比對私鑰與憑證是否匹配；不匹配或已過期的憑證會被擋下。" />
      </el-form>
      <template #footer>
        <el-button @click="certDlg.visible = false">取消</el-button>
        <el-button type="primary" :loading="certDlg.saving" @click="saveCert">上傳並驗證</el-button>
      </template>
    </el-dialog>

    <!-- 部署即時 Log 視窗 -->
    <el-dialog v-model="deployDlg.visible" title="一鍵同步部署" width="820px" top="5vh" class="rwd-dialog"
               :close-on-click-modal="false" :before-close="closeDeploy">
      <el-alert v-if="deployDlg.state !== 'running'" :closable="false" show-icon :title="deployDlg.message"
                :type="deployDlg.state === 'success' ? 'success' : deployDlg.state === 'warning' ? 'warning' : 'error'" />
      <el-alert v-else :closable="false" type="info" title="部署中，請勿關閉視窗…" show-icon />
      <div ref="logBox" class="logbox">
        <div v-for="(l, i) in deployDlg.lines" :key="i" class="logline" :class="l.level">
          <span class="ts">{{ new Date(l.ts).toLocaleTimeString('zh-TW', { hour12: false }) }}</span>
          <span v-if="l.node" class="node">[{{ l.node }}]</span>
          <span>{{ l.msg }}</span>
        </div>
        <div v-if="!deployDlg.lines.length" class="logline info">等待伺服器回應…</div>
      </div>
      <template v-if="deployDlg.errorDetail">
        <div class="err-title">錯誤詳情（遠端原始輸出）</div>
        <pre class="code err">{{ deployDlg.errorDetail }}</pre>
      </template>
      <template #footer>
        <el-button :disabled="deployDlg.running" type="primary" @click="closeDeploy">關閉</el-button>
      </template>
    </el-dialog>

    <!-- 節點 Nginx Log -->
    <el-dialog v-model="nodeLogDlg.visible" :title="`Nginx Log：${nodeLogDlg.node?.NodeName || ''}`" width="1000px" top="4vh"
               class="rwd-dialog" @closed="stopNodeLogTimer(); nodeLogDlg.auto = false">
      <div class="toolbar nlog-bar">
        <el-radio-group v-model="nodeLogDlg.type" size="small" @change="loadNodeLog">
          <el-radio-button value="access">存取紀錄 access.log</el-radio-button>
          <el-radio-button value="error">錯誤紀錄 error.log</el-radio-button>
          <el-radio-button value="waf">WAF 事件 waf.log</el-radio-button>
        </el-radio-group>
        <el-select v-if="nodeLogDlg.type === 'waf'" v-model="nodeLogDlg.domain" size="small" class="nlog-domain"
                   placeholder="全部網域（waf.log）" @change="loadNodeLog">
          <template #prefix>網域</template>
          <el-option label="全部網域（waf.log）" value="" />
          <el-option v-for="d in wafLogDomains" :key="d.name" :value="d.name"
                     :label="d.on ? d.name : `${d.name}（WAF 未開啟）`" />
        </el-select>
        <el-select v-model="nodeLogDlg.lines" size="small" class="nlog-lines" @change="loadNodeLog">
          <el-option v-for="n in NODE_LOG_LINES" :key="n" :label="`最後 ${n} 行`" :value="n" />
        </el-select>
        <el-input v-model="nodeLogDlg.q" size="small" clearable :prefix-icon="Search" placeholder="關鍵字（IP、網址、狀態碼…）"
                  class="nlog-q" @keyup.enter="loadNodeLog" @clear="loadNodeLog" />
        <el-button size="small" type="primary" :icon="Refresh" :loading="nodeLogDlg.loading" @click="loadNodeLog">重新讀取</el-button>
        <el-checkbox v-model="nodeLogDlg.auto" size="small" @change="toggleNodeLogAuto">每 5 秒自動更新</el-checkbox>
        <el-checkbox v-model="nodeLogDlg.newestFirst" size="small">最新的在最上面</el-checkbox>
      </div>
      <el-alert v-if="nodeLogDlg.error" type="error" :closable="false" show-icon :title="nodeLogDlg.error">
        <pre v-if="nodeLogDlg.hint" class="nlog-hint">{{ nodeLogDlg.hint }}</pre>
      </el-alert>
      <template v-else-if="nodeLogDlg.data">
        <div class="hint">
          {{ nodeLogDlg.data.file }} ·
          <template v-if="nodeLogDlg.data.keyword">在最後 {{ nodeLogDlg.data.scanned.toLocaleString() }} 行中找到含「{{ nodeLogDlg.data.keyword }}」的 {{ nodeLogDlg.data.lines.length }} 行（最多顯示 {{ nodeLogDlg.data.count }} 行）</template>
          <template v-else>共 {{ nodeLogDlg.data.lines.length }} 行</template>
          · 讀取時間 {{ fmt(nodeLogDlg.data.fetchedAt) }}
        </div>
        <div v-if="nodeLogDlg.type === 'waf'" class="hint">
          橘色 = 命中規則（Warning，僅偵測也會記錄），紅色 = 已阻擋（Access denied，id 949110 為總分判定）。
          誤判時把同一請求中 <code>[id "…"]</code> 的規則 ID（949110 除外）填入該網域的「WAF 排除規則」。
        </div>
        <div class="logbox nlog-box">
          <div v-if="!nodeLogLines.length" class="logline">（沒有資料）</div>
          <div v-for="(l, i) in nodeLogLines" :key="i" class="logline" :class="nodeLogClass(l)">{{ l }}</div>
        </div>
      </template>
      <div v-else-if="nodeLogDlg.loading" class="hint">讀取中…</div>
    </el-dialog>

    <!-- 部署紀錄詳情 -->
    <el-dialog v-model="logDlg.visible" :title="`部署紀錄 #${logDlg.data?.Id}`" width="820px" top="5vh" class="rwd-dialog">
      <template v-if="logDlg.data">
        <div class="node-chips">
          <el-tag v-for="r in logDlg.data.NodeResults" :key="r.nodeId" size="large"
                  :type="r.error ? 'danger' : 'success'">{{ r.name }} · {{ r.error ? '失敗' : '正常' }}</el-tag>
        </div>
        <pre v-if="logDlg.data.ErrorDetail" class="code err">{{ logDlg.data.ErrorDetail }}</pre>
        <pre class="code">{{ localizeLog(logDlg.data.LogText) }}</pre>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.page { max-width: 1400px; margin: 0 auto; padding: 16px; }
.topbar { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; margin-bottom: 16px; }
.topbar h1 { margin: 0; font-size: 22px; color: #1f2d3d; }
.sub { color: #7b8794; font-size: 13px; margin-top: 2px; }
.actions { display: flex; align-items: center; gap: 12px; }
.user { color: #666; font-size: 13px; }
.form-hint { color: #909399; font-size: 12px; line-height: 1.5; margin-top: 4px; width: 100%; }
.fp-row { display: flex; gap: 8px; width: 100%; }
.light.sm { width: 10px; height: 10px; display: inline-block; vertical-align: middle; margin-right: 6px; }

.nodes { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-bottom: 8px; }
.node-card { flex: 1 1 280px; max-width: 420px; }
.node-card.inactive { opacity: 0.6; }
.domain-link { color: var(--el-color-primary); text-decoration: none; word-break: break-all; }
.domain-link:hover { text-decoration: underline; }
.date-cell { font-size: 12px; color: #606266; white-space: nowrap; }
.waf-ok { color: #67c23a; }
.waf-miss { color: #f56c6c; }
.warn-text { color: #e6a23c; }
.tab-label { display: inline-flex; align-items: center; gap: 4px; }
.waf-page { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); gap: 16px; align-items: start; }
.waf-page > .el-alert { grid-column: 1 / -1; }
.waf-card .hint { margin-left: 10px; }
@media (max-width: 900px) { .waf-page { grid-template-columns: 1fr; } }
.idle-days { font-size: 12px; color: #909399; white-space: nowrap; }
.rule-del-btn { float: left; }
.cut-body { min-height: 160px; }
.cut-summary { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
.cut-summary .hint { margin-left: auto; }
.cut-issue { display: flex; align-items: flex-start; gap: 6px; line-height: 1.6; margin: 2px 0; font-size: 13px; }
.cut-issue .el-tag { flex: none; }
.cut-ok { color: var(--el-color-success); font-size: 13px; }
.cut-detail { padding: 4px 16px; font-size: 13px; line-height: 1.9; color: #606266; word-break: break-all; }
.cut-req { display: inline-block; margin-right: 12px; }
.cut-req small { color: #909399; }
.cut-pass { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-top: 12px; padding: 8px 12px; background: var(--el-color-success-light-9); border-radius: 4px; font-size: 13px; }
.cut-manual { margin-top: 12px; }
.cut-manual ul { margin: 4px 0 0; padding-left: 18px; }
.mono { font-family: Consolas, 'Courier New', monospace; }
.mono.small, .small { font-size: 12px; }
.idle-days.long { color: #e6a23c; }
.node-tools { display: flex; align-items: center; gap: 12px; flex: none; }
.node-tools .el-button + .el-button { margin-left: 0; }
.node-row { display: flex; align-items: center; gap: 12px; }
.node-info { flex: 1; min-width: 0; }
.node-name { font-weight: 600; }
.node-meta { color: #7b8794; font-size: 12px; line-height: 1.6; }
.res { margin-top: 10px; display: grid; gap: 4px; }
.res-row { display: grid; grid-template-columns: 36px 1fr auto; align-items: center; gap: 8px; font-size: 12px; color: #606266; }
.res-label { color: #909399; }
.res-val { font-variant-numeric: tabular-nums; min-width: 92px; text-align: right; }
.res-err { margin-top: 8px; font-size: 12px; color: #e6a23c; }

.light { width: 14px; height: 14px; border-radius: 50%; flex: none; background: #c0c4cc; }
.light.green { background: #3fb950; box-shadow: 0 0 0 4px rgba(63, 185, 80, 0.2); animation: pulse 2s infinite; }
.light.yellow { background: #e3b341; box-shadow: 0 0 0 4px rgba(227, 179, 65, 0.25); }
.light.red { background: #f85149; box-shadow: 0 0 0 4px rgba(248, 81, 73, 0.2); }
.light.off { background: #dcdfe6; }
@keyframes pulse { 50% { box-shadow: 0 0 0 7px rgba(63, 185, 80, 0); } }

.toolbar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
.hint { color: #909399; font-size: 12px; }
.nlog-bar { margin-bottom: 8px; }
.nlog-lines { width: 120px; }
.nlog-domain { width: 240px; }
.nlog-q { width: 240px; }
/* 需比後面的 .logbox（固定 340px）更明確才不會被蓋掉；視窗 top 4vh，扣掉標題列與工具列約 250px */
.logbox.nlog-box { height: calc(92vh - 250px); min-height: 360px; }
.nlog-hint { margin: 8px 0 0; white-space: pre-wrap; font-family: Consolas, 'Courier New', monospace; font-size: 12px; }
@media (max-width: 768px) { .nlog-q, .nlog-lines, .nlog-domain { width: 100%; } }
.row-count { margin-left: auto; color: #606266; font-size: 13px; white-space: nowrap; }
.row-count b { color: var(--el-color-primary); font-weight: 600; }
.search { width: 240px; }
.search.wide { width: 320px; }
.sel { width: 130px; }
.range { max-width: 280px; }
.pager { margin-top: 12px; justify-content: flex-end; flex-wrap: wrap; }
.ups { display: grid; gap: 2px; }
.ups-item { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.ups-item.off { color: #c0c4cc; text-decoration: line-through; }
/* 後端連線燈號：綠＝全部節點可連、黃＝部分節點可連、紅＝全部連不上、灰＝尚未檢測、淡灰＝已停用 */
.dot { width: 9px; height: 9px; border-radius: 50%; flex: none; display: inline-block; background: #c0c4cc; cursor: help; }
.dot.green { background: #3fb950; }
.dot.yellow { background: #e3b341; }
.dot.red { background: #f85149; }
.dot.off { background: #ebeef5; }
.ups-method { justify-self: start; margin-top: 2px; }
.ups-edit { width: 100%; display: grid; gap: 6px; }
.ups-head, .ups-row { display: grid; grid-template-columns: minmax(120px, 1fr) 110px 90px 40px 44px 32px; gap: 6px; align-items: center; }
.ups-head { font-size: 12px; color: #909399; line-height: 1.4; }
.ups-row .el-input-number { width: 100%; }
.ups-edit > .el-button { justify-self: start; }
.ups-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.probe-body { min-height: 120px; }
.probe-meta { margin-left: 8px; font-size: 12px; color: #909399; line-height: 1.5; }
div.probe-meta { margin: 4px 0 0; }
.probe-err { margin-top: 8px; }
.imp-pick { margin: 14px 0; display: grid; gap: 10px; }
.imp-file { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 26px 16px; border: 2px dashed #c0c4cc; border-radius: 10px; cursor: pointer; color: #606266; text-align: center; }
.imp-file:hover { border-color: #409eff; color: #409eff; }
.imp-file input { display: none; }
.imp-help { background: #f7f8fa; border-radius: 8px; padding: 10px 14px; font-size: 13px; color: #4a5568; }
.imp-help-title { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-weight: 600; }
.imp-help ul { margin: 6px 0 0; padding-left: 18px; line-height: 1.8; }
.imp-help code { background: #eceef2; padding: 0 4px; border-radius: 3px; }
.imp-summary { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
.imp-backends { word-break: break-all; }
.imp-err { color: #f56c6c; line-height: 1.6; }
.imp-warn { color: #e6a23c; line-height: 1.6; }
.imp-ok { color: #67c23a; }
:deep(.el-table .imp-error) { --el-table-tr-bg-color: #fef0f0; }
:deep(.el-table .imp-duplicate) { --el-table-tr-bg-color: #fdf6ec; }
.audit-detail { white-space: pre-line; font-size: 12.5px; line-height: 1.5; color: #4a5568; max-height: 9em; overflow: auto; }
.cert-cell { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 150px; }

.mono :deep(textarea) { font-family: Consolas, 'Courier New', monospace; font-size: 13px; }
.code { background: #0d1117; color: #c9d1d9; padding: 12px; border-radius: 6px; overflow: auto; max-height: 50vh; font-size: 12.5px; line-height: 1.5; white-space: pre-wrap; word-break: break-all; margin: 10px 0 0; }
.code.err { background: #2d0f12; color: #ffb4b4; }
.err-title { margin-top: 12px; font-weight: 600; color: #f56c6c; }

.logbox { margin-top: 12px; background: #0d1117; border-radius: 6px; padding: 10px 12px; height: 340px; overflow: auto; font-family: Consolas, 'Courier New', monospace; font-size: 12.5px; line-height: 1.6; }
.logline { color: #c9d1d9; white-space: pre-wrap; word-break: break-all; }
.logline .ts { color: #6e7681; margin-right: 8px; }
.logline .node { color: #79c0ff; margin-right: 6px; }
.logline.ok { color: #56d364; }
.logline.warn { color: #e3b341; }
.logline.error { color: #ff7b72; }
.node-chips { display: flex; gap: 8px; flex-wrap: wrap; }

@media (max-width: 768px) {
  .page { padding: 10px; }
  .topbar h1 { font-size: 18px; }
  .node-card { flex-basis: 100%; max-width: none; }
  /* 手機版：重新整理 / 新增節點按鈕獨立一列放在卡片上方右側，不再擠壓卡片 */
  .node-tools { order: -1; width: 100%; justify-content: flex-end; }
  .actions { width: 100%; justify-content: space-between; }
  .search, .search.wide, .sel, .range { width: 100%; max-width: none; }
  .ups-head { display: none; }
  .ups-row { grid-template-columns: 1fr 1fr; }
}
</style>

<style>
/* 小螢幕時 Dialog 滿版 */
@media (max-width: 768px) {
  .rwd-dialog.el-dialog { width: 94% !important; margin-top: 3vh !important; }
  .rwd-dialog .el-form-item { flex-wrap: wrap; }
}
</style>
