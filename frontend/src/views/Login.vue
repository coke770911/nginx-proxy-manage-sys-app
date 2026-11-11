<script setup>
import { reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { User, Lock } from '@element-plus/icons-vue';
import { login } from '../api';

const form = reactive({ username: '', password: '' });
const loading = ref(false);
const error = ref('');

async function submit() {
  error.value = '';
  if (!form.username.trim() || !form.password) {
    error.value = '請輸入帳號與密碼';
    return;
  }
  loading.value = true;
  try {
    const res = await login(form.username.trim(), form.password);
    ElMessage.success(`歡迎，${res.username}`);
  } catch (e) {
    error.value = e.message;
    form.password = '';
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="login-page">
    <el-card class="login-card" shadow="always">
      <h1>Nginx HA Proxy Manager</h1>
      <div class="sub">校園網域反向代理與 SSL 憑證集中管理系統</div>
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
        <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon class="err" />
        <el-button type="primary" size="large" class="btn" :loading="loading" native-type="submit">登入</el-button>
      </el-form>
      <div class="hint">僅限系統特權帳號登入（經 SOAP 帳號驗證）</div>
    </el-card>
  </div>
</template>

<style scoped>
.login-page {
  min-height: 100vh;
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
</style>
