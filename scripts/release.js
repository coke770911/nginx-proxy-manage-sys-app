'use strict';
/**
 * 發佈腳本：npm run release        → 升版號、更新 README、commit、tag、push
 *          npm run release -- --no-push  → 只做到 tag，不 push
 *
 * 流程
 *  1. 確認工作目錄乾淨（所有變更都已 commit）
 *  2. 依規則計算新版號，寫入 VERSION 與 backend/frontend 的 package.json
 *  3. 更新 README：「目前版本」行，並在「更新紀錄」加入本版 commit 摘要
 *  4. git commit "release: vX.Y.Z" + 建立 tag vX.Y.Z
 *  5. git push（含 tag）
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const ver = require('./version');

const git = (...args) => execFileSync('git', args, { cwd: ver.ROOT, encoding: 'utf8' }).trim();
const noPush = process.argv.includes('--no-push');

function fail(msg) {
  console.error(`\n✘ ${msg}\n`);
  process.exit(1);
}

// 1. 工作目錄必須乾淨
if (git('status', '--porcelain')) fail('還有未 commit 的變更，請先 commit（記得同時更新 README）再發佈。');

// 2. 計算版號
const cur = ver.read();
const nv = ver.next(cur);

let lastTag = '';
try { lastTag = git('describe', '--tags', '--abbrev=0', '--match', 'v*'); } catch (_) { /* 尚無 tag */ }
const range = lastTag ? [`${lastTag}..HEAD`] : [];
const subjects = git('log', ...range, '--no-merges', '--pretty=format:%s')
  .split('\n')
  .map((s) => s.trim())
  .filter((s) => s && !s.startsWith('release:'));
if (lastTag && !subjects.length) fail(`自 ${lastTag} 之後沒有新的 commit，不需要發佈。`);

ver.write(nv);
for (const p of ['backend/package.json', 'frontend/package.json']) {
  const file = path.join(ver.ROOT, p);
  if (!fs.existsSync(file)) continue;
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  pkg.version = nv;
  fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
}

// 3. 更新 README
const readmePath = path.join(ver.ROOT, 'README.md');
let readme = fs.readFileSync(readmePath, 'utf8');
const today = new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD
readme = readme.replace(/目前版本：\*\*v[\d.]+\*\*/, `目前版本：**v${nv}**`);
const entry = `### v${nv}（${today}）\n\n${subjects.map((s) => `- ${s}`).join('\n')}\n`;
if (!readme.includes('## 更新紀錄')) readme += '\n## 更新紀錄\n';
readme = readme.replace(/## 更新紀錄\n+/, `## 更新紀錄\n\n${entry}\n`);
fs.writeFileSync(readmePath, readme);

// 4. commit + tag
git('add', 'VERSION', 'README.md', 'backend/package.json', 'frontend/package.json');
git('commit', '-m', `release: v${nv}`);
git('tag', '-a', `v${nv}`, '-m', `v${nv}`);
console.log(`✔ 已發佈 v${cur} → v${nv}`);

// 5. push
if (noPush) {
  console.log('（--no-push）尚未推送，稍後執行：git push origin HEAD --follow-tags');
} else {
  try {
    git('remote', 'get-url', 'origin');
  } catch (_) {
    fail('尚未設定遠端 origin。請先執行：git remote add origin <GitHub 網址>，再執行 git push -u origin main --follow-tags');
  }
  execFileSync('git', ['push', '-u', 'origin', 'HEAD', '--follow-tags'], { cwd: ver.ROOT, stdio: 'inherit' });
  console.log('✔ 已推送至 origin');
}
