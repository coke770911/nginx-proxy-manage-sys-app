'use strict';
/**
 * 版號規則 x.y.z
 *  - 每次發佈 z + 1
 *  - z 超過 20 → z 歸 0、y + 1（例：1.0.20 → 1.1.0）
 *  - y 超過 20 → y 歸 0、x + 1（例：1.20.20 → 2.0.0）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const VERSION_FILE = path.join(ROOT, 'VERSION');
const MAX = 20;

function parse(v) {
  const m = String(v).trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) throw new Error(`VERSION 格式錯誤：「${v}」，應為 x.y.z`);
  return m.slice(1).map(Number);
}

function next(v) {
  let [x, y, z] = parse(v);
  z += 1;
  if (z > MAX) { z = 0; y += 1; }
  if (y > MAX) { y = 0; x += 1; }
  return `${x}.${y}.${z}`;
}

const read = () => fs.readFileSync(VERSION_FILE, 'utf8').trim();
const write = (v) => fs.writeFileSync(VERSION_FILE, `${v}\n`);

module.exports = { ROOT, MAX, parse, next, read, write };

// 直接執行：node scripts/version.js [--test]
if (require.main === module) {
  if (process.argv.includes('--test')) {
    const cases = [['1.0.0', '1.0.1'], ['1.0.19', '1.0.20'], ['1.0.20', '1.1.0'], ['1.19.20', '1.20.0'], ['1.20.20', '2.0.0']];
    cases.forEach(([a, b]) => {
      const r = next(a);
      console.log(`${r === b ? 'PASS' : 'FAIL'}  ${a} → ${r}（預期 ${b}）`);
      if (r !== b) process.exitCode = 1;
    });
  } else {
    const cur = read();
    console.log(`目前版本 ${cur}，下一版 ${next(cur)}`);
  }
}
