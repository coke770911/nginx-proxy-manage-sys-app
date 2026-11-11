/**
 * PM2 設定檔（Windows Server / Linux 皆可用）
 *
 * 使用方式（在專案根目錄）：
 *   npm run install:all && npm run build   # 安裝相依套件、編譯前端到 backend/public
 *   pm2 start ecosystem.config.js          # 啟動
 *   pm2 save                               # 記住目前程序清單，服務重啟後自動還原
 *
 * 注意：只能跑 1 個執行個體（fork 模式），不可改成 cluster。
 * 部署鎖、登入失敗鎖定、SSE 即時 Log、節點資源數據都存在記憶體，多個執行個體會互相看不到。
 */
const path = require('path');

module.exports = {
  apps: [
    {
      name: 'nginx-ha-proxy-manager',
      cwd: path.join(__dirname, 'backend'), // 讓 dotenv 讀到 backend/.env
      script: 'src/app.js',
      instances: 1,
      exec_mode: 'fork',

      autorestart: true,
      max_restarts: 10, // 連續啟動失敗（例如 .env 設定錯誤）10 次就停止，避免無限重啟
      min_uptime: '10s', // 執行未滿 10 秒就結束視為啟動失敗
      restart_delay: 3000,
      max_memory_restart: '500M',
      kill_timeout: 5000,
      watch: false,

      // Log：放在專案 logs/（已列入 .gitignore），建議搭配 pm2 install pm2-logrotate
      out_file: path.join(__dirname, 'logs', 'out.log'),
      error_file: path.join(__dirname, 'logs', 'error.log'),
      merge_logs: true,
      time: true, // 每行 Log 加上時間

      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
