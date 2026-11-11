<script setup>
import Dashboard from './views/Dashboard.vue';
import Login from './views/Login.vue';
import { session } from './api';
</script>

<template>
  <Dashboard v-if="session.token" />
  <Login v-else />
</template>

<style>
body {
  margin: 0;
  background: #f4f6fa;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft JhengHei', 'PingFang TC', sans-serif;
}
</style>
