'use strict';
/**
 * 登入圖片驗證碼（四碼數字）
 * - 以 Node 內建 zlib 直接產生 PNG（不需額外套件、不依賴字型），數字以點陣字型繪製並加上傾斜、位移、干擾線與雜點。
 * - 驗證碼只存在伺服器記憶體：一次性使用（不論對錯，驗證一次即作廢）、預設 3 分鐘到期。
 * - 前端只拿到圖片與隨機 id，答案不會出現在任何回應中。
 */
const crypto = require('crypto');
const zlib = require('zlib');

const TTL_MS = 3 * 60000;
const MAX_ENTRIES = 5000; // 記憶體上限，超過時淘汰最舊的
const W = 120;
const H = 44;

const store = new Map(); // id -> { code, exp }

/* 5×7 點陣數字 */
const FONT = {
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
};

const rnd = (min, max) => min + crypto.randomInt(max - min + 1);

/* ---------------------------------------------------------------- PNG 編碼 */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(px) {
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y += 1) {
    raw[y * (W * 3 + 1)] = 0; // filter: none
    px.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------------------------------------------------------- 繪圖 */
function render(code) {
  const px = Buffer.alloc(W * H * 3);
  const bg = [rnd(235, 250), rnd(235, 250), rnd(235, 250)];
  for (let i = 0; i < W * H; i += 1) px.set(bg, i * 3);
  const set = (x, y, c) => {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= W || yi >= H) return;
    px.set(c, (yi * W + xi) * 3);
  };
  const darkColor = () => [rnd(10, 110), rnd(10, 110), rnd(10, 110)];

  // 雜點
  for (let i = 0; i < 260; i += 1) set(rnd(0, W - 1), rnd(0, H - 1), [rnd(120, 220), rnd(120, 220), rnd(120, 220)]);

  // 數字：每個點陣格放大成 4×4，整個字隨機傾斜與上下位移
  const cell = 4;
  [...code].forEach((d, i) => {
    const color = darkColor();
    const shear = (crypto.randomInt(61) - 30) / 100; // -0.30 ~ 0.30
    const x0 = 8 + i * 27 + rnd(-2, 2);
    const y0 = 8 + rnd(-4, 3);
    FONT[d].forEach((row, ry) => {
      [...row].forEach((bit, rx) => {
        if (bit !== '1') return;
        for (let dy = 0; dy < cell; dy += 1) {
          for (let dx = 0; dx < cell; dx += 1) {
            const y = y0 + ry * cell + dy;
            set(x0 + rx * cell + dx + (y - y0 - 14) * shear, y, color);
          }
        }
      });
    });
  });

  // 干擾線（兩點寬）
  for (let n = 0; n < 4; n += 1) {
    const c = darkColor();
    let x = rnd(0, W - 1);
    let y = rnd(0, H - 1);
    const x2 = rnd(0, W - 1);
    const y2 = rnd(0, H - 1);
    const steps = Math.max(Math.abs(x2 - x), Math.abs(y2 - y)) || 1;
    const sx = (x2 - x) / steps;
    const sy = (y2 - y) / steps;
    for (let s = 0; s <= steps; s += 1) {
      set(x, y, c);
      set(x, y + 1, c);
      x += sx;
      y += sy;
    }
  }
  return encodePng(px);
}

/* ---------------------------------------------------------------- API */
function cleanup() {
  const now = Date.now();
  for (const [id, v] of store) if (v.exp < now) store.delete(id);
}
setInterval(cleanup, 60000).unref();

/** 產生新驗證碼：回傳 { id, image（data URL）, expiresIn（秒） } */
function create() {
  if (store.size >= MAX_ENTRIES) {
    cleanup();
    while (store.size >= MAX_ENTRIES) store.delete(store.keys().next().value);
  }
  const code = String(crypto.randomInt(10000)).padStart(4, '0');
  const id = crypto.randomBytes(16).toString('hex');
  store.set(id, { code, exp: Date.now() + TTL_MS });
  return { id, image: `data:image/png;base64,${render(code).toString('base64')}`, expiresIn: TTL_MS / 1000 };
}

/** 驗證（一次性）：不論對錯都作廢；回傳 'ok' / 'expired'（找不到或過期）/ 'wrong' */
function verify(id, answer) {
  const key = String(id || '');
  const v = store.get(key);
  store.delete(key);
  if (!v || v.exp < Date.now()) return 'expired';
  const a = Buffer.from(String(answer || '').trim().padEnd(4, ' ').slice(0, 4));
  const b = Buffer.from(v.code);
  return crypto.timingSafeEqual(a, b) ? 'ok' : 'wrong';
}

module.exports = { create, verify };
