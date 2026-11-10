# 代理規則（AI Agent / 開發者共同遵守）

本專案為「校園網域反向代理與 SSL 憑證集中管理系統（Nginx HA Proxy Manager）」。
所有回答、說明、commit 訊息與文件一律使用**繁體中文**。

## 1. 每次 commit 前必須更新 README.md

- 任何 commit 都要同時修改 `README.md`，說明本次變更影響的功能、設定或注意事項。
- `.githooks/pre-commit` 會檢查：commit 未包含 README.md 即阻擋。
- 僅限緊急狀況可用 `SKIP_README_CHECK=1 git commit ...` 略過，事後須補上 README。

## 2. push 前必須升版號（x.y.z）

| 規則 | 範例 |
|---|---|
| 每次發佈 z + 1 | 1.0.0 → 1.0.1 |
| z 超過 20 → z 歸 0、y + 1 | 1.0.20 → 1.1.0 |
| y 超過 20 → y 歸 0、x + 1 | 1.20.20 → 2.0.0 |

- 版號唯一來源為根目錄 `VERSION`，**不可手動修改**，一律執行 `npm run release`。
- `npm run release` 會：升版 → 同步 `backend/` 與 `frontend/` 的 package.json → 更新 README 的「目前版本」與「更新紀錄」→ commit `release: vX.Y.Z` → 建立 tag → push。
- `.githooks/pre-push` 會檢查 HEAD 是否帶有 `v<VERSION>` tag，沒有就阻擋 push。

## 3. 標準工作流程

```bash
# 第一次 clone 後啟用 hooks
npm run setup-hooks

# 開發 → 更新 README → commit
git add -A
git commit -m "新增：xxx 功能"

# 發佈（升版 + push）
npm run release
```

## 4. 安全規則

- 絕不 commit `backend/.env`、私鑰（`*.key`、`*.pem`）、`*.pfx`；新增設定項目時同步更新 `backend/.env.example`。
- 修改 `nginxTemplate.js` 時，所有插入設定檔的欄位必須經過 `validateRule()` 白名單驗證。
- 修改部署流程（`deployService.js`）時，必須維持「全部節點 `nginx -t` 通過才 reload，任一失敗即回滾」的原則。
