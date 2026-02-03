# YouTube to NotebookLM Chrome拡張

YouTubeページに表示されている動画をNotebookLMに一括登録するChrome拡張機能です。

## インストール手順

### 1. アイコンを生成

1. `generate-icons.html` をブラウザで開く
2. 「すべてダウンロード」ボタンをクリック
3. ダウンロードされた3つのPNGファイルを `icons/` フォルダに移動

### 2. Chrome拡張として読み込む

1. Chromeで `chrome://extensions/` を開く
2. 右上の「デベロッパーモード」をONにする
3. 「パッケージ化されていない拡張機能を読み込む」をクリック
4. このフォルダ（`allnblm`）を選択

## 使い方

1. YouTubeのページ（動画視聴ページ、検索結果、チャンネルページなど）を開く
2. 拡張機能のアイコン（ブラウザ右上）をクリック
3. ページ内の動画リストが表示される
4. 登録したい動画にチェックを入れる（デフォルトですべて選択）
5. 「NotebookLMに登録」ボタンをクリック
6. NotebookLMが開き、自動的にURLが入力される

## 注意事項

- NotebookLMには公式APIがないため、UIの自動操作で実装しています
- NotebookLMのUI変更により動作しなくなる可能性があります
- 自動入力が失敗した場合は、URLがクリップボードにコピーされます

## ファイル構成

```
allnblm/
├── manifest.json          # 拡張機能の設定
├── popup.html             # ポップアップUI
├── popup.js               # ポップアップのロジック
├── background.js          # バックグラウンド処理
├── notebooklm-content.js  # NotebookLM用スクリプト
├── generate-icons.html    # アイコン生成ツール
├── icons/                 # アイコン画像
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md
```
