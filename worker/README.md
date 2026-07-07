# 相談ナビ用 Cloudflare Worker（Gemini APIプロキシ）

`consult.html`（AI相談ページ）から呼び出される最小プロキシです。

## 役割

- **APIキーの秘匿**: Gemini APIキーはこのWorkerの環境変数（secret）にのみ置き、
  フロントエンドやリポジトリには一切含めません。
- **安全制約の固定**: 「診断しない・薬剤を提案しない・最大4問・緊急時は打ち切り」等の
  システムプロンプトをWorker側に持つため、フロント改ざんでは制約を外せません。
- **出力形式の強制**: Gemini の `responseSchema` で応答JSONの形を強制します。
- **プライバシー**: 相談本文はGemini APIへの転送にのみ使い、保存やログ出力は行いません。
- **CORS**: `https://iwatas-hub.github.io` と `http://localhost` / `http://127.0.0.1` のみ許可。
- **簡易レート制限**: 同一IPあたり1日50リクエスト（アイソレート内メモリの簡易実装。
  厳密化する場合は Workers KV / Durable Objects へ — コード内TODO参照）。

## デプロイ手順

前提: Node.js がインストール済みであること（wrangler は npx で都度実行するので
グローバルインストール不要）。

```sh
cd worker

# 1. Cloudflareアカウントにログイン（ブラウザが開きます）
npx wrangler login

# 2. Gemini APIキーをsecretとして登録（プロンプトにキーを貼り付ける）
#    キーは https://aistudio.google.com/apikey で取得
npx wrangler secret put GEMINI_API_KEY

# 3. デプロイ
npx wrangler deploy
```

デプロイ完了時に表示されるURL（例: `https://kyoto-ninchisho-consult.<account>.workers.dev`）を
控えてください。

## フロントエンドの切り替え

`consult.html` の `<script>` 冒頭にある `CONFIG` を編集します:

```js
const CONFIG = {
  WORKER_URL: "https://kyoto-ninchisho-consult.<account>.workers.dev",  // ← デプロイ先URL
  MOCK: false                                                            // ← falseで本番AIに切替
};
```

`MOCK: true` のままなら Worker を呼ばず内蔵ダミー応答で動作します（開発・デモ用）。

## ローカルでの動作確認（任意）

```sh
cd worker
npx wrangler dev
# → http://localhost:8787 で起動。consult.html の WORKER_URL に設定すればローカル検証できる
#   （CORSは localhost を許可済み）
```

## API仕様

- `POST /` — リクエスト: `{"messages": [{"role": "user|assistant", "content": "..."}], "force_done": false}`
- レスポンス: consult.html と共有しているJSON契約（`phase` / `next_question` / `result`）
- エラー時: `{"error": "..."}` を 4xx/5xx で返す
