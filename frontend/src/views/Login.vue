<script setup>
import { onMounted, onBeforeUnmount, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { User, Lock, Key, Refresh } from '@element-plus/icons-vue';
import api, { login } from '../api';

const form = reactive({ username: '', password: '', captcha: '' });
const loading = ref(false);
const error = ref('');

/* ---------------------------------------------- 圖片驗證碼（四碼數字，一次性使用） */
const captchaOn = ref(true);
const cap = reactive({ id: '', image: '', loading: false });
const captchaRef = ref();
let expireTimer = null;

async function loadCaptcha() {
  if (!captchaOn.value) return;
  cap.loading = true;
  form.captcha = '';
  clearTimeout(expireTimer);
  try {
    const r = await api.get('/auth/captcha');
    cap.id = r.id;
    cap.image = r.image;
    // 到期前 10 秒自動換一張，避免輸入後才發現已失效
    expireTimer = setTimeout(loadCaptcha, Math.max(10, (r.expiresIn || 180) - 10) * 1000);
  } catch (e) {
    cap.id = '';
    cap.image = '';
    error.value = e.message;
  } finally {
    cap.loading = false;
  }
}

onMounted(async () => {
  try {
    captchaOn.value = (await api.get('/auth/config')).captcha !== false;
  } catch { /* 取不到設定時仍顯示驗證碼 */ }
  loadCaptcha();
});
onBeforeUnmount(() => clearTimeout(expireTimer));

const onlyDigits = (v) => { form.captcha = String(v || '').replace(/\D/g, '').slice(0, 4); };

async function submit() {
  error.value = '';
  if (!form.username.trim() || !form.password) {
    error.value = '請輸入帳號與密碼';
    return;
  }
  if (captchaOn.value && !/^\d{4}$/.test(form.captcha)) {
    error.value = '請輸入圖片中的四碼數字';
    captchaRef.value?.focus();
    return;
  }
  loading.value = true;
  try {
    const res = await login(form.username.trim(), form.password, cap.id, form.captcha);
    clearTimeout(expireTimer);
    const dept = (res.departments || []).join('、');
    ElMessage.success(`歡迎，${res.name || res.username}${dept ? `（${dept}）` : ''}`);
  } catch (e) {
    error.value = e.message;
    // 驗證碼錯誤時保留密碼，只要重新輸入驗證碼；其他錯誤清除密碼
    if (!e.data?.captchaInvalid) form.password = '';
    loadCaptcha(); // 驗證碼為一次性，失敗後一律換新
    if (e.data?.captchaInvalid) captchaRef.value?.focus();
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="login-page">
    <el-card class="login-card" shadow="always">
      <h1>Nginx HA Proxy Manager</h1>
      <div class="sub">反向代理伺服器節點管理系統</div>
      <el-form @submit.prevent="submit">
        <el-form-item>
          <el-input v-model="form.username" :prefix-icon="User" placeholder="帳號" size="large" autocomplete="username" autofocus />
        </el-form-item>
        <el-form-item>
          <el-input
            v-model="form.password" :prefix-icon="Lock" type="password" placeholder="密碼" size="large"
            show-password autocomplete="current-password" @keyup.enter="submit"
          />
        </el-form-item>
        <el-form-item v-if="captchaOn">
          <div class="captcha-row">
            <el-input
              ref="captchaRef" :model-value="form.captcha" :prefix-icon="Key" placeholder="驗證碼（四碼數字）" size="large"
              inputmode="numeric" maxlength="4" autocomplete="off" @update:model-value="onlyDigits" @keyup.enter="submit"
            />
            <button type="button" class="captcha-img" title="看不清楚？點圖片換一張" :disabled="cap.loading" @click="loadCaptcha">
              <img v-if="cap.image" :src="cap.image" alt="驗證碼圖片" width="120" height="44">
              <span v-else class="captcha-empty">載入中…</span>
            </button>
            <el-button :icon="Refresh" circle size="small" title="換一張" :loading="cap.loading" @click="loadCaptcha" />
          </div>
        </el-form-item>
        <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon class="err" />
        <el-button type="primary" size="large" class="btn" :loading="loading" native-type="submit">登入</el-button>
      </el-form>
      <div class="hint">僅限系統授權帳號登入（以學校帳號密碼驗證）</div>
    </el-card>
  </div>
</template>

<style scoped>
.login-page {
  min-height: calc(100vh - 60px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  box-sizing: border-box;
}
.login-card { width: 100%; max-width: 380px; }
h1 { font-size: 22px; margin: 4px 0; text-align: center; }
.sub { color: #888; font-size: 13px; text-align: center; margin-bottom: 24px; }
.err { margin-bottom: 16px; }
.btn { width: 100%; }
.hint { color: #aaa; font-size: 12px; text-align: center; margin-top: 16px; }
.captcha-row { display: flex; align-items: center; gap: 8px; width: 100%; }
.captcha-row .el-input { flex: 1; min-width: 0; }
.captcha-img {
  flex: none; width: 120px; height: 44px; padding: 0; border: 1px solid var(--el-border-color);
  border-radius: 4px; overflow: hidden; cursor: pointer; background: #f5f5f5;
}
.captcha-img img { display: block; }
.captcha-empty { font-size: 12px; color: #999; }
</style>
