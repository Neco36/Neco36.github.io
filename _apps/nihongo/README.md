# にほんごチェック

LINE の会話のスクショを Claude でチェックし、漢字の読みを練習するアプリ。
claude.ai の Artifact として公開している：https://claude.ai/artifact/6y4YDhvtt5ZMHtZD73swEV

- チェック：Artifact の `sample` 機能で、開いている人の Claude アカウント（Claude Haiku 5.5）を使う。API キー不要
- 記録：Artifact の `db` 機能で、その人専用の領域（`data/users/<id>/`）に保存。使えないときはブラウザ内に保存
- ふりがな：kuromoji.js。辞書はページと一緒に `dict/` として公開する

## ビルド

```sh
npm install
npm run build   # dist/nihongo.html と dist/dict/ を作る
```

公開するときは `dist/nihongo.html` をページに、`dist/dict/*.dat.gz` を `dict/` に（contentType `application/wasm`）置き、
capabilities は `{"sample": {"images": true}, "db": {}, "user": {}}`。
