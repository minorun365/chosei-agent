# Chosei Agent

Slack に日程調整ページの URL を投げると、Agent が候補日時を読み取り、Google Calendar の予定と照らし合わせて、参加可否を入力するサンプルです。

エージェント本体は Strands Agents で書き、Amazon Bedrock AgentCore Runtime 上で動かします。Web ページの読み取りとフォーム入力には AgentCore Browser Tool を使います。

## できること

- Slack の `app_mention` を Lambda Function URL で受け取る
- Slack リクエストの署名を検証する
- AgentCore Runtime 上の Strands Agent に依頼文を渡す
- AgentCore Browser Tool で日程調整ページを開く
- Google Calendar API で候補日時の空き状況を確認する
- 迷わない場合は、ページへ参加可否を入力する

## 構成

```text
Slack App
  ↓ app_mention
Lambda Function URL
  ├─ Slack署名検証
  ├─ チーム / チャンネル確認
  └─ Slackスレッド返信
  ↓ InvokeAgentRuntime
AgentCore Runtime
  ├─ Strands Agent
  ├─ AgentCore Browser Tool
  └─ check_availability
```

Slack 固有の処理は Lambda に閉じ込めています。日程調整ページの読み取り、カレンダー確認、入力判断は AgentCore Runtime 側で行います。

## リポジトリ構成

```text
.
├── cdk.json
├── package.json
├── tsconfig.json
├── infra/
│   └── cdk.ts
├── lambda/
│   └── index.ts
└── runtime/
    ├── Dockerfile
    ├── calendar_tool.py
    ├── main.py
    └── requirements.txt
```

## 前提

- AWS アカウントと AWS CLI
- Node.js 22 以降
- Docker
- Python 3.10 以降
- Slack App
- Google Calendar API を有効化した Google Cloud プロジェクト

## 設定

デプロイ前に、次の環境変数を設定します。

```sh
export AWS_REGION="ap-northeast-1"

export GOOGLE_CLIENT_ID="..."
export GOOGLE_CLIENT_SECRET="..."
export GOOGLE_REFRESH_TOKEN="..."
export GOOGLE_CALENDAR_ID="primary"
export SCHEDULING_DISPLAY_NAME="Your Name"

export SLACK_SIGNING_SECRET="..."
export SLACK_BOT_TOKEN="xoxb-..."
export SLACK_TEAM_ID="T..."
export SLACK_CHANNEL_ID="C..."
```

`SLACK_CHANNEL_ID` は任意ですが、検証中は指定しておくと安心です。想定外のチャンネルで Bot が反応するのを防げます。

## デプロイ

依存関係をインストールします。

```sh
npm install
```

対象の AWS アカウントとリージョンで初めて CDK を使う場合は、bootstrap を実行します。

```sh
npx cdk bootstrap
```

スタックをデプロイします。

```sh
npm run build
npx cdk deploy
```

デプロイ後、出力された `SlackAdapterUrl` を Slack App の Event Subscriptions にある Request URL へ設定します。その後、Bot Events に `app_mention` を追加し、Slack App を再インストールします。

## メモ

このサンプルは Google Calendar の予定を読みますが、Slack には予定タイトルを返しません。カレンダー確認用のツールは、候補日時ごとに予定あり / 予定なしだけを返します。

AgentCore Browser Tool まわりの Runtime IAM 権限は、サンプルとして動かしやすいよう広めにしています。本番に近い環境で使う場合は、必要な action に絞ってください。
