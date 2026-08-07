#!/usr/bin/env bash
# .rust-lambda-docker-cache/targetは、account-pipeline-stack.tsのLambdaバンドリング
# (SAMビルドイメージ内でのDocker経由Rustビルド)が使う共有キャッシュで、`npm test`/
# `npm run deploy`のたびに肥大化し続ける(全パッケージ・全バイナリで共有される単一のtarget
# ディレクトリのため)。`cargo clean`による全消しは次回バンドリングを丸ごとやり直しに
# してしまうので、cargo-sweep(要 `cargo install cargo-sweep`;未インストールでもビルド自体
# は失敗させない)で削る。
#
# 基準は--maxsize(サイズ上限)ではなく--time(未アクセス日数)を主軸にしている。cargoは
# 再コンパイルが不要な場合でも「最新か」を判定するため全fingerprintファイルを読むので、
# 実際に使われ続けている成果物はOSのatimeが更新され続ける(このリポジトリの/はext4+
# relatimeでatime更新が有効なことを確認済み)。したがって「N日読まれていない
# =本当にもう要らない」と判定でき、サイズ上限のような当てずっぽうの数字を置かずに済む。
# host側の/target(.githooks/pre-commitで--time 14)より長めの30日にしているのは、
# こちらはコミット毎ではなくinfra作業(npm test/npm run deploy)のときだけ触られるため。
#
# --maxsizeは上記のtimeベース掃除だけでは異常事態(短期間に大量の成果物が生成される等)を
# 防げないためのセーフティネットとして併用する。通常運用ではtimeベースの掃除で完結し、
# maxsizeが実際に効くことは想定していない。
#
# package.jsonのposttest/postdeployから毎回自動実行される。
#
# 実行方法の注意: このキャッシュはrepoRoot/Cargo.tomlとは別ディレクトリ
# (.rust-lambda-docker-cache/target)にホストパスとして存在し、Dockerコンテナ内でのみ
# /asset-input/targetとしてrepoRootと同じ階層にマウントされる。そのためcargo-sweepに
# `.rust-lambda-docker-cache`を直接パスとして渡すと、対象ディレクトリにCargo.tomlが
# 存在せず`cargo metadata`が失敗する(確認済み)。repoRoot(実際のCargo.tomlがある場所)
# から実行しつつ、CARGO_TARGET_DIR環境変数で対象のtargetディレクトリだけを差し替える。
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

if ! command -v cargo-sweep >/dev/null 2>&1; then
  echo "  (cargo-sweep未インストールのため.rust-lambda-docker-cache/targetの自動整理をスキップ: cargo install cargo-sweep)"
  exit 0
fi

if [ ! -d .rust-lambda-docker-cache/target ]; then
  exit 0
fi

DAYS="${RUST_LAMBDA_DOCKER_CACHE_DAYS:-30}"
echo "==> cargo sweep: .rust-lambda-docker-cache/target の${DAYS}日未アクセスの成果物を削除"
CARGO_TARGET_DIR=.rust-lambda-docker-cache/target cargo sweep --time "${DAYS}"

# セーフティネット: 上記で十分削れなかった場合のみ効く上限(通常は発火しない想定)。
MAXSIZE="${RUST_LAMBDA_DOCKER_CACHE_MAXSIZE:-8GB}"
CARGO_TARGET_DIR=.rust-lambda-docker-cache/target cargo sweep --maxsize "${MAXSIZE}"
