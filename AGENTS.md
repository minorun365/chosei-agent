# AGENTS.md

このリポジトリは、Slack から日程調整ページの URL を投げると、AgentCore Runtime 上の Strands Agent がページを開き、Google Calendar の予定を見て参加可否を入力するサンプルです。

## 作業の前提

- 応答は日本語で行う。
- 公開リポジトリなので、秘密情報や個人の検証環境メモをコミットしない。
- デプロイや外部サービス検証の前に、存在する場合は `.codex/local-context.md` を読む。
- `.env.example` は公開用の雛形、`.env.local` や `.codex/local-context.md` はローカル専用として扱う。
- `.env`、`.env.*`、Slack / Google / AWS のシークレット、OAuth トークン、実際の Bot Token は絶対にコミットしない。

## ディレクトリ

```text
.
├── agent/        # AgentCore Runtime で動かす Strands Agent
├── cdk/          # AWS CDK のスタック定義
├── lambda/       # Slack Events API を受ける Lambda
├── README.md     # リポジトリ利用者向けの説明
└── draft.md      # 公開前の本文ドラフト。秘密情報は書かない
```

## 実装ルール

- `agent/`、`cdk/`、`lambda/` の構成を保つ。古い `runtime/` や `infra/` という名前に戻さない。
- コードを変えたら、README やドラフトの手順・コード断片も実装に合わせて更新する。
- サンプルとして読みやすいことを優先し、不要に大きな抽象化を足さない。
- コメントは、初見の読者が意図を追いやすい主要箇所に絞って書く。

## 検証

基本の確認コマンドは次の通り。

```sh
npm install
npm run build
PYTHONPYCACHEPREFIX=/private/tmp/chosei-agent-pycache python3 -m py_compile agent/main.py agent/calendar_tool.py
```

AWS へデプロイする前に、対象プロファイルとアカウントを確認する。

```sh
aws sts get-caller-identity --profile "$AWS_PROFILE"
```

Slack、Google、AWS の外部サービスへ書き込む検証では、ワークスペース、チャンネル、Google アカウント、AWS アカウント、リージョンを確認してから実行する。
