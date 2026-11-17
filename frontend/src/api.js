import axios from 'axios';
import { reactive } from 'vue';

const TOKEN_KEY = 'jwt';
const USER_KEY = 'username';

const read = (k) => { try { return sessionStorage.getItem(k) || ''; } catch { return ''; } };
const write = (k, v) => { try { if (v) sessionStorage.setItem(k, v); else sessionStorage.removeItem(k); } catch { /* ignore */ } };

const PROFILE_KEY = 'profile';
const readProfile = () => {
  try {
    const p = JSON.parse(read(PROFILE_KEY) || '{}');
    return { name: String(p.name || ''), departments: Array.isArray(p.departments) ? p.departments.map(String) : [] };
  } catch { return { name: '', departments: [] }; }
};

/** 登入狀態（JWT 存於 sessionStorage，關閉分頁即需重新登入）；name / departments 來自認證服務 userDataConnect */
export const session = reactive({ token: read(TOKEN_KEY), username: read(USER_KEY), ...readProfile() });

export function setSession(token, username, profile = {}) {
  session.token = token || '';
  session.username = username || '';
  session.name = String(profile.name || '');
  session.departments = Array.isArray(profile.departments) ? profile.departments.map(String) : [];
  write(TOKEN_KEY, session.token);
  write(USER_KEY, session.username);
  write(PROFILE_KEY, session.token ? JSON.stringify({ name: session.name, departments: session.departments }) : '');
}

export const logout = () => setSession('', '');

const api = axios.create({ baseURL: '/api', timeout: 120000 });

api.interceptors.request.use((cfg) => {
  if (session.token) cfg.headers.Authorization = `Bearer ${session.token}`;
  return cfg;
});

// 成功回傳 res.data；失敗統一把後端 message / 完整 body 掛到 Error 上
api.interceptors.response.use(
  (res) => res.data,
  (err) => {
    const data = err.response?.data;
    const status = err.response?.status;
    // Token 過期或帳號被移出白名單 → 回到登入畫面（登入 API 本身的 401 不處理）
    if ((status === 401 || status === 403) && !err.config?.url?.startsWith('/auth/login')) logout();
    const e = new Error(data?.message || err.message);
    e.data = data;
    e.status = status;
    return Promise.reject(e);
  },
);

export async function login(username, password, captchaId, captcha) {
  const res = await api.post('/auth/login', { username, password, captchaId, captcha });
  setSession(res.token, res.username, { name: res.name, departments: res.departments });
  return res;
}

/** EventSource 無法帶自訂標頭，以 query 傳 JWT */
export const eventsUrl = () => `/api/deploy/events?token=${encodeURIComponent(session.token)}`;

export default api;
