<script setup>
import { ref, reactive, computed, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Upload, Refresh, Plus, Edit, Delete, View, UploadFilled, SwitchButton } from '@element-plus/icons-vue';
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
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    loading.value = false;
  }
}

/* ------------------------------------------------------------------ 共用工具 */
const fmt = (d) => (d ? new Date(d).toLocaleString('zh-TW', { hour12: false }) : '—');
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
const lightClass = (n) => (n.IsActive ? LIGHT[n.HealthStatus] || 'grey' : 'off');

const STATUS_TAG = {
  SUCCESS: { type: 'success', text: '成功' },
  FAILED: { type: 'danger', text: '失敗' },
  ROLLED_BACK: { type: 'warning', text: '已回滾' },
  PARTIAL: { type: 'warning', text: '部分成功' },
  RUNNING: { type: 'info', text: '執行中' },
};

// 有規則/憑證在最近一次成功部署之後被修改 → 提示尚未部署
const pendingChanges = computed(() => {
  const last = logs.value.find((l) => l.Status === 'SUCCESS');
  const lastTs = last?.FinishedAt ? new Date(last.FinishedAt).getTime() : 0;
  const newest = Math.max(0, ...rules.value.map((r) => new Date(r.UpdatedAt).getTime()), ...certs.value.map((c) => new Date(c.UpdatedAt).getTime()));
  return newest > lastTs;
});

/* ------------------------------------------------------------------ 節點 */
async function checkNodes() {
  checking.value = true;
  try {
    nodes.value = await api.post('/nodes/check');
    ElMessage.success('節點連線檢測完成');
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
const blankRule = () => ({
  DomainName: '', TargetIp: '', TargetPort: 80, CertificateId: null,
  ForceHttps: true, EnableWebSocket: false, ClientMaxBodySize: '50M',
  IsActive: true, IsMaintenance: false, CustomNginxSnippet: '', Remark: '',
});
const ruleDlg = reactive({ visible: false, id: null, saving: false, form: blankRule() });
const ruleFormRef = ref();
const ruleRules = {
  DomainName: [{ required: true, message: '請輸入來源網域', trigger: 'blur' }],
  TargetIp: [{ required: true, message: '請輸入後端 IP', trigger: 'blur' }],
  TargetPort: [{ required: true, message: '請輸入 Port', trigger: 'blur' }],
  CertificateId: [{ required: true, message: '請選擇 SSL 憑證', trigger: 'change' }],
};

function openRule(row) {
  ruleDlg.id = row ? row.Id : null;
  ruleDlg.form = row ? { ...blankRule(), ...row, certificate: undefined } : blankRule();
  ruleDlg.visible = true;
}

async function saveRule() {
  await ruleFormRef.value.validate();
  ruleDlg.saving = true;
  try {
    const body = { ...ruleDlg.form };
    delete body.certificate;
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

async function removeRule(row) {
  try {
    await ElMessageBox.confirm(`確定刪除規則「${row.DomainName}」？`, '刪除確認', { type: 'warning' });
  } catch { return; }
  try {
    await api.delete(`/rules/${row.Id}`);
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

onBeforeUnmount(() => { if (es) es.close(); });

/* ------------------------------------------------------------------ 部署紀錄詳情 */
const logDlg = reactive({ visible: false, data: null });
async function showLog(row) {
  try {
    logDlg.data = await api.get(`/deploy/logs/${row.Id}`);
    logDlg.visible = true;
  } catch (e) { ElMessage.error(e.message); }
}

onMounted(loadAll);
</script>

<template>
  <div class="page" v-loading="loading">
    <!-- 標題列 -->
    <header class="topbar">
      <div>
        <h1>Nginx HA Proxy Manager</h1>
        <div class="sub">校園網域反向代理與 SSL 憑證集中管理系統</div>
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
          </div>
          <el-switch :model-value="n.IsActive" size="small" @change="(v) => toggleNode(n, v)" />
          <el-button size="small" :icon="Edit" circle text title="編輯節點" @click="openNode(n)" />
        </div>
      </el-card>
      <el-button :icon="Refresh" :loading="checking" circle title="重新檢測節點連線" @click="checkNodes" />
      <el-button :icon="Plus" circle title="新增節點" @click="openNode(null)" />
    </section>

    <el-tabs v-model="tab" class="tabs">
      <!-- ============ 網域規則 ============ -->
      <el-tab-pane label="網域對照規則" name="rules">
        <div class="toolbar">
          <el-button type="primary" :icon="Plus" @click="openRule(null)">新增規則</el-button>
          <span class="hint">修改後需按右上角「一鍵同步部署」才會推送到 Nginx 節點。</span>
        </div>
        <el-table :data="rules" stripe border style="width: 100%" empty-text="尚無規則">
          <el-table-column prop="DomainName" label="來源網域" min-width="200" fixed />
          <el-table-column label="後端目標" min-width="160">
            <template #default="{ row }">{{ row.TargetIp }}:{{ row.TargetPort }}</template>
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
          <el-table-column label="啟用" width="80" align="center">
            <template #default="{ row }"><el-switch :model-value="row.IsActive" size="small" @change="(v) => quickToggle(row, 'IsActive', v)" /></template>
          </el-table-column>
          <el-table-column label="維護中頁面" width="110" align="center">
            <template #default="{ row }"><el-switch :model-value="row.IsMaintenance" size="small" active-color="#e6a23c" @change="(v) => quickToggle(row, 'IsMaintenance', v)" /></template>
          </el-table-column>
          <el-table-column prop="Remark" label="備註" min-width="160" show-overflow-tooltip />
          <el-table-column label="操作" width="190" fixed="right" align="center">
            <template #default="{ row }">
              <el-button size="small" :icon="View" circle title="預覽 Nginx 設定" @click="previewRule(row)" />
              <el-button size="small" :icon="Edit" circle title="編輯" @click="openRule(row)" />
              <el-button size="small" type="danger" :icon="Delete" circle title="刪除" @click="removeRule(row)" />
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
          <el-table-column label="操作" width="110" fixed="right" align="center">
            <template #default="{ row }">
              <el-button size="small" :icon="Edit" circle title="編輯" @click="openNode(row)" />
              <el-button size="small" type="danger" :icon="Delete" circle title="刪除" @click="removeNode(row)" />
            </template>
          </el-table-column>
        </el-table>
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
    </el-tabs>

    <!-- 規則編輯 -->
    <el-dialog v-model="ruleDlg.visible" :title="ruleDlg.id ? '編輯網域規則' : '新增網域規則'" width="680px" top="5vh" class="rwd-dialog">
      <el-form ref="ruleFormRef" :model="ruleDlg.form" :rules="ruleRules" label-width="130px" label-position="right">
        <el-form-item label="來源網域" prop="DomainName"><el-input v-model="ruleDlg.form.DomainName" placeholder="portal.aeust.edu.tw" /></el-form-item>
        <el-form-item label="後端 IP / Port" required>
          <el-input v-model="ruleDlg.form.TargetIp" placeholder="10.0.0.21" style="width: 62%" />
          <el-input-number v-model="ruleDlg.form.TargetPort" :min="1" :max="65535" controls-position="right" style="width: 36%; margin-left: 2%" />
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
        <el-form-item label="上傳檔案上限"><el-input v-model="ruleDlg.form.ClientMaxBodySize" placeholder="50M" style="width: 160px" /></el-form-item>
        <el-form-item label="自訂 Nginx 語法">
          <el-input v-model="ruleDlg.form.CustomNginxSnippet" type="textarea" :rows="5" class="mono"
                    placeholder="插入 443 server 區塊，例如：&#10;proxy_buffering off;&#10;add_header X-Frame-Options SAMEORIGIN;" />
        </el-form-item>
        <el-form-item label="備註"><el-input v-model="ruleDlg.form.Remark" maxlength="500" /></el-form-item>
      </el-form>
      <template #footer>
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

    <!-- 部署紀錄詳情 -->
    <el-dialog v-model="logDlg.visible" :title="`部署紀錄 #${logDlg.data?.Id}`" width="820px" top="5vh" class="rwd-dialog">
      <template v-if="logDlg.data">
        <div class="node-chips">
          <el-tag v-for="r in logDlg.data.NodeResults" :key="r.nodeId" size="large"
                  :type="r.error ? 'danger' : 'success'">{{ r.name }} · {{ r.error ? '失敗' : '正常' }}</el-tag>
        </div>
        <pre v-if="logDlg.data.ErrorDetail" class="code err">{{ logDlg.data.ErrorDetail }}</pre>
        <pre class="code">{{ logDlg.data.LogText }}</pre>
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
.node-row { display: flex; align-items: center; gap: 12px; }
.node-info { flex: 1; min-width: 0; }
.node-name { font-weight: 600; }
.node-meta { color: #7b8794; font-size: 12px; line-height: 1.6; }

.light { width: 14px; height: 14px; border-radius: 50%; flex: none; background: #c0c4cc; }
.light.green { background: #3fb950; box-shadow: 0 0 0 4px rgba(63, 185, 80, 0.2); animation: pulse 2s infinite; }
.light.yellow { background: #e3b341; box-shadow: 0 0 0 4px rgba(227, 179, 65, 0.25); }
.light.red { background: #f85149; box-shadow: 0 0 0 4px rgba(248, 81, 73, 0.2); }
.light.off { background: #dcdfe6; }
@keyframes pulse { 50% { box-shadow: 0 0 0 7px rgba(63, 185, 80, 0); } }

.toolbar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
.hint { color: #909399; font-size: 12px; }
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
  .node-card { max-width: none; }
  .actions { width: 100%; justify-content: space-between; }
}
</style>

<style>
/* 小螢幕時 Dialog 滿版 */
@media (max-width: 768px) {
  .rwd-dialog.el-dialog { width: 94% !important; margin-top: 3vh !important; }
  .rwd-dialog .el-form-item { flex-wrap: wrap; }
}
</style>
