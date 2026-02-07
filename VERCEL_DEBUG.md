# Vercelでのデバッグ方法

## 変更内容

以下の改善を行いました:

### 1. 詳細なログ出力
- すべてのログにISO形式のタイムスタンプを追加
- 各関数の開始・終了をログに記録
- エラー時にスタックトレースを出力
- fetch操作の前後でログを出力

### 2. タイムアウト処理
- すべてのfetch操作に8秒のタイムアウトを設定
- Vercelの環境でハングアップしないように対策

### 3. エラーハンドリング強化
- try-catchブロックを追加
- ネットワークエラーを適切にキャッチ
- エラー時に詳細情報を出力

## Vercelでログを確認する方法

### 方法1: Vercel Dashboard
1. https://vercel.com にアクセス
2. プロジェクトを選択
3. 「Deployments」タブをクリック
4. 最新のデプロイメントをクリック
5. 「Runtime Logs」タブでリアルタイムログを確認

### 方法2: Vercel CLI
```bash
# Vercel CLIをインストール(まだの場合)
npm i -g vercel

# ログインする
vercel login

# リアルタイムでログを確認
vercel logs --follow
```

### 方法3: ヘルスチェックエンドポイント
ブラウザで以下のURLにアクセス:
```
https://your-app.vercel.app/
```

以下の情報が表示されます:
- サーバーの稼働状態
- 環境変数の設定状態
- キャッシュの状態

## デバッグの流れ

1. **環境変数を確認**
   - Vercel Dashboardで環境変数が正しく設定されているか確認
   - `TODOIST_TOKEN`と`SLACK_SIGNING_SECRET`が設定されているか

2. **ヘルスチェックを実行**
   - `https://your-app.vercel.app/` にアクセス
   - 環境変数が正しく読み込まれているか確認

3. **Slackコマンドを実行**
   - Slackで `/todoist テスト 明日 浦本` を実行

4. **ログを確認**
   - Vercel Dashboardの「Runtime Logs」で詳細ログを確認
   - タイムスタンプ付きで各処理の進行状況を追跡
   - エラーが発生した箇所を特定

## よくある問題と解決方法

### 問題1: 環境変数が設定されていない
**症状**: `❌ Not set` と表示される

**解決方法**:
1. Vercel Dashboard → Settings → Environment Variables
2. `TODOIST_TOKEN` と `SLACK_SIGNING_SECRET` を追加
3. Redeploy

### 問題2: タイムアウトエラー
**症状**: `AbortError: The operation was aborted`

**解決方法**:
- Todoist APIのレスポンスが遅い可能性
- ログで具体的にどのAPI呼び出しでタイムアウトしているか確認
- 必要に応じてタイムアウト時間を延長(現在8秒)

### 問題3: プロジェクトが見つからない
**症状**: `winova_slack✖️todoist プロジェクトが見つかりません`

**解決方法**:
- ログで利用可能なプロジェクト一覧を確認
- プロジェクト名が正確に一致しているか確認
- 特殊文字(✖️)が正しくエンコードされているか確認

## ログの見方

### 正常な実行例
```
[DEBUG 2026-02-07T11:00:00.000Z] Main handler: Starting task creation
[DEBUG 2026-02-07T11:00:00.100Z] Main handler: Using project: winova_slack✖️todoist
[DEBUG 2026-02-07T11:00:00.200Z] resolveProjectId: Starting for "winova_slack✖️todoist"
[DEBUG 2026-02-07T11:00:00.300Z] getTodoistProjects: Starting
[DEBUG 2026-02-07T11:00:00.400Z] getTodoistProjects: Fetching from API
[DEBUG 2026-02-07T11:00:01.500Z] getTodoistProjects: Response status 200
[DEBUG 2026-02-07T11:00:01.600Z] getTodoistProjects: Success, 5 projects
[DEBUG 2026-02-07T11:00:01.700Z] resolveProjectId: Match found: winova_slack✖️todoist
[DEBUG 2026-02-07T11:00:01.800Z] getUserIdByName: Starting for "浦本雅"
...
```

### エラー発生時の例
```
[DEBUG 2026-02-07T11:00:00.000Z] Main handler: Starting task creation
[DEBUG 2026-02-07T11:00:00.100Z] getTodoistProjects: Starting
[DEBUG 2026-02-07T11:00:00.200Z] getTodoistProjects: Fetching from API
[ERROR 2026-02-07T11:00:08.300Z] getTodoistProjects: AbortError: The operation was aborted
[ERROR 2026-02-07T11:00:08.400Z] getTodoistProjects: Stack: ...
```

## 次のステップ

1. Vercelにデプロイ
2. ヘルスチェックエンドポイントで環境変数を確認
3. Slackコマンドを実行
4. Runtime Logsで詳細を確認
5. 問題があればログを共有してください
