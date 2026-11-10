import axios from 'axios';

const getToken = () => {
  try { return localStorage.getItem('apiToken') || ''; } catch { return ''; }
};

const api = axios.create({ baseURL: '/api', timeout: 120000 });

api.interceptors.request.use((cfg) => {
  const t = getToken();
  if (t) cfg.headers['x-api-token'] = t;
  return cfg;
});

// 成功回傳 res.data；失敗統一把後端 message / 完整 body 掛到 Error 上
api.interceptors.response.use(
  (res) => res.data,
  (err) => {
    const data = err.response?.data;
    if (err.response?.status === 401) {
      const t = window.prompt('此系統需要 API Token，請輸入：');
      if (t) {
        try { localStorage.setItem('apiToken', t); } catch { /* ignore */ }
        window.location.reload();
      }
    }
    const e = new Error(data?.message || err.message);
    e.data = data;
    return Promise.reject(e);
  },
);

/** EventSource 無法帶自訂標頭，以 query 傳 token */
export const eventsUrl = () => {
  const t = getToken();
  return `/api/deploy/events${t ? `?token=${encodeURIComponent(t)}` : ''}`;
};

export default api;
