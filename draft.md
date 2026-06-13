# SlackにURLを投げるだけ。Amazon Bedrock AgentCoreで日程調整代理入力エージェントを作る

AWS Community Hero のみのるんです。

AIエージェントというと、専用のチャット画面を用意して、そこに質問を投げるものを想像しがちです。それも便利ですが、日常の細かい作業では、Slack のようないつもの場所からそのまま頼める方がありがたい場面も多いです。

今回は、Slack に日程調整ページの URL を投げると、エージェントがページを開き、Google カレンダーと突き合わせ、迷わなければそのまま入力する Bot を作ります。

このサンプルでは、エージェントの中身を [Strands Agents](https://strandsagents.com/) で書きます。Strands Agents は、モデル、システムプロンプト、ツールを組み合わせてエージェントを作るためのオープンソース SDK です。ユーザーの依頼を受けて、どのツールを使うかを Agent が判断します。

その Strands Agent を AWS 上で動かす場所として Amazon Bedrock AgentCore Runtime を使います。Web ページを開いて候補日を読み取り、フォームに入力するところは AgentCore Browser Tool に任せます。

関係を先にまとめると、Strands Agents が「次に何をするか」を判断し、AgentCore Runtime がその Agent を動かし、ブラウザ操作は AgentCore Browser Tool が担当します。細かいコードは後で出てきますが、まずはこの分担だけ押さえておけば読み進めやすいです。AgentCore の全体像は [Amazon Bedrock AgentCore の Overview](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/what-is-bedrock-agentcore.html) も参考になります。

Slack では、Bot にこう投げるだけです。

```text
@chosei-agent https://example.com/schedule/...
```

Bot は Slack スレッドに結果を返します。

```text
日程調整ページに入力しました。
6/15(月) 19:00〜 ×
6/16(火) 19:00〜 ○
6/17(水) 19:00〜 ×
6/18(木) 19:00〜 ×
6/19(金) 19:00〜 ○
```

この記事は、AWS アカウントの作成や AWS CLI の基本操作はなんとなく分かるけれど、AgentCore は初めて、という方を想定しています。Mac でローカル開発する前提で進めます。Windows や Linux の方は、パスやシェルコマンドを適宜読み替えてください。

完全なコードは、[GitHub リポジトリ][sample-code-repo]で公開予定です。本文では、手順を上から追えるようにしながら、載せるコードは主要部だけに絞ります。

## 作るもの

作る部品は、Slack の受け口、AgentCore Runtime、Google カレンダー確認用のツールの3つです。

```text
Slack App
  ↓ app_mention
Lambda Function URL
  ├─ Slack署名検証
  ├─ team / channel guard
  └─ Slackスレッド返信
  ↓ InvokeAgentRuntime
AgentCore Runtime
  ├─ Strands Agent
  ├─ AgentCore Browser Tool
  └─ check_availability
```

Slack から AgentCore Runtime を直接呼ばず、間に Lambda を置きます。Slack には URL verification や署名検証があり、この処理を Runtime 本体へ混ぜると、Slack 対応のコードと日程調整のコードがすぐ絡まってしまうためです。

Lambda は Slack の受け口だけを担当します。Slack の署名を検証し、Slack スレッドから `session_id` を作り、本文を Runtime の `prompt` に渡します。候補日の読み取り、Google カレンダー確認、入力するか聞き返すかの判断は Runtime 側で行います。

## ローカル環境を用意する

この記事では Mac でローカル開発します。Windows や Linux の方は、パスやシェルコマンドを読み替えてください。

先に確認しておくものは次の5つです。

- AWS アカウントと AWS CLI v2。インストールがまだなら [AWS CLI v2 のインストール手順](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) を見て、`aws sts get-caller-identity` が成功する状態にしておきます。
- Node.js と npm。この記事では Node.js 22 系で確認しています。
- Docker Desktop など、Docker イメージをビルドできる環境。
- Python 3.10 以上。Google Calendar API の Quickstart で OAuth token を作るときに使います。
- VS Code などのエディタ。

AWS のリージョンは `ap-northeast-1` を使います。

## プロジェクトを作る

まず作業ディレクトリを作ります。

```sh
mkdir chosei-agent
cd chosei-agent
mkdir -p runtime lambda infra
```

今回は `cdk init app --language typescript` は使いません。CDK の標準テンプレートは `bin/` や `lib/` などを作ってくれるので、CDK に慣れている人には自然です。ただ、この記事では Runtime、Lambda、CDK の3つを横に並べた方が、どのコードが何をしているか追いやすくなります。

そのため、[GitHub リポジトリ][sample-code-repo]では必要なファイルだけを置く最小構成にしています。

```text
chosei-agent/
├── cdk.json
├── package.json
├── tsconfig.json
├── infra/
│   └── cdk.ts
├── lambda/
│   └── index.ts
└── runtime/
    ├── calendar_tool.py
    ├── Dockerfile
    ├── main.py
    └── requirements.txt
```

CDK の作法に慣れている方は、`cdk init` で作った `bin/` / `lib/` 構成に読み替えても問題ありません。ここでは、`runtime/` を AgentCore Runtime のコンテナとしてデプロイし、`lambda/` を Slack の入口として置く、という関係だけ押さえてください。

Node.js 側の依存関係を入れます。

```sh
npm init -y
npm install aws-cdk-lib constructs @aws-sdk/client-bedrock-agentcore @aws-sdk/client-lambda
npm install -D aws-cdk typescript @types/node esbuild
```

`package.json` の scripts は、この記事ではこの2つだけ使います。

```json
{
  "scripts": {
    "build": "tsc",
    "cdk": "npm run build && cdk"
  }
}
```

`cdk.json` は CDK アプリの入口を指定するだけです。

```json
{
  "app": "node dist/infra/cdk.js"
}
```

## Runtimeを作る

まずエージェント本体を置く `runtime/` から作ります。Slack から届いた文章を受け取り、Strands Agent に渡す部分です。

`runtime/requirements.txt` に必要な Python パッケージを書きます。

```text
aws-opentelemetry-distro
bedrock-agentcore>=1.14.1
nest-asyncio
playwright>=1.58.0
strands-agents>=1.35.1
strands-agents-tools
```

Browser Tool も使うため、Runtime はコンテナで動かします。`runtime/Dockerfile` は最小限にします。

```dockerfile
FROM public.ecr.aws/docker/library/python:3.13-slim

WORKDIR /app
ENV PYTHONUNBUFFERED=1

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8080
CMD ["python", "main.py"]
```

Google カレンダーを見る処理は `runtime/calendar_tool.py` に分けます。Runtime の入口と外部 API の処理を分けておくと、あとで読み返したときに迷いにくくなります。

ここでは候補日時の配列を受け取り、それぞれについて `○` / `×` を返す `check_availability` を作ります。Agent には、候補開始時刻を JST の ISO 8601 形式にしてからこのツールを呼ぶように伝えます。

```python
from __future__ import annotations

import json
import os
import urllib.parse
import urllib.request
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from strands import tool

JST = ZoneInfo("Asia/Tokyo")


# Google OAuthのrefresh tokenからCalendar API用access tokenを取得する
def google_access_token() -> str:
    body = urllib.parse.urlencode(
        {
            "client_id": os.environ["GOOGLE_CLIENT_ID"],
            "client_secret": os.environ["GOOGLE_CLIENT_SECRET"],
            "refresh_token": os.environ["GOOGLE_REFRESH_TOKEN"],
            "grant_type": "refresh_token",
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        "https://oauth2.googleapis.com/token",
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.loads(response.read().decode("utf-8"))["access_token"]


# ISO 8601の日時をJST基準にそろえる
def parse_jst(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=JST)
    return parsed.astimezone(JST)


# Google Calendarから指定範囲に重なる予定を取得する
def calendar_events(time_min: datetime, time_max: datetime) -> list[tuple[datetime, datetime]]:
    calendar_id = urllib.parse.quote(os.getenv("GOOGLE_CALENDAR_ID", "primary"), safe="")
    query = urllib.parse.urlencode(
        {
            "timeMin": time_min.isoformat(),
            "timeMax": time_max.isoformat(),
            "singleEvents": "true",
            "orderBy": "startTime",
            "timeZone": "Asia/Tokyo",
        }
    )
    request = urllib.request.Request(
        f"https://www.googleapis.com/calendar/v3/calendars/{calendar_id}/events?{query}",
        headers={"Authorization": f"Bearer {google_access_token()}"},
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        data = json.loads(response.read().decode("utf-8"))

    events = []
    for item in data.get("items", []):
        start = item.get("start", {}).get("dateTime") or item.get("start", {}).get("date")
        end = item.get("end", {}).get("dateTime") or item.get("end", {}).get("date")
        if item.get("status") != "cancelled" and item.get("transparency") != "transparent" and start and end:
            events.append((parse_jst(start), parse_jst(end)))
    return events


# 候補日時ごとの空き状況をJSTで判定する
@tool
def check_availability(candidates: list[str], duration_minutes: int = 60) -> list[dict[str, str]]:
    """候補日時ごとの予定有無を確認する

    Args:
        candidates: 候補開始時刻の配列。必ずJSTのISO 8601形式で指定する
        duration_minutes: 各候補の長さ。終了時刻がページにない場合は60分で確認する
    """

    slots = []
    for candidate in candidates:
        start = parse_jst(candidate)
        slots.append((candidate, start, start + timedelta(minutes=duration_minutes)))

    if not slots:
        return []

    events = calendar_events(min(slot[1] for slot in slots), max(slot[2] for slot in slots))
    results = []
    for original, start, end in slots:
        busy_count = sum(1 for event_start, event_end in events if start < event_end and event_start < end)
        results.append(
            {
                "candidate": original,
                "start_jst": start.strftime("%Y-%m-%d %H:%M"),
                "end_jst": end.strftime("%Y-%m-%d %H:%M"),
                "availability": "予定あり" if busy_count else "予定なし",
                "answer": "×" if busy_count else "○",
                "busy_count": str(busy_count),
            }
        )
    return results
```

Calendar API から予定タイトルは取りません。ツールの返却値も `予定あり` / `予定なし` と `○` / `×` だけにしています。Slack に予定名を出さないためです。

次に `runtime/main.py` を作ります。Slack から届いた本文を `prompt` として受け取り、Strands Agent に渡すファイルです。

```python
from __future__ import annotations

import os
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from bedrock_agentcore import BedrockAgentCoreApp
from calendar_tool import check_availability
from strands import Agent
from strands.models import BedrockModel
from strands_tools.browser import AgentCoreBrowser

app = BedrockAgentCoreApp()

REGION = os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION") or "ap-northeast-1"
MODEL_ID = os.getenv("BEDROCK_MODEL_ID", "jp.anthropic.claude-sonnet-4-6")
DISPLAY_NAME = os.getenv("SCHEDULING_DISPLAY_NAME", "みのるん")
JST = ZoneInfo("Asia/Tokyo")


# 毎回新しいAgentを作り、前回実行の会話履歴を持ち越さない
def create_agent() -> Agent:
    today = datetime.now(JST).date().isoformat()
    system_prompt = f"""
あなたは日程調整ページの代理入力エージェントです。
今日の日付は {today}、タイムゾーンは Asia/Tokyo です。
BrowserでURLを開き、候補日時を読み取り、候補開始時刻をJSTのISO 8601形式に変換してcheck_availabilityで予定を確認してください。
check_availabilityのanswerが○なら参加可能、×なら予定ありとして入力し、迷わなければ表示名「{DISPLAY_NAME}」で送信してください。
URL、本人情報、候補日時、送信可否が曖昧なときだけユーザーに質問してください。
カレンダーの予定名はユーザーに出さず、予定あり/なしだけで扱ってください。
Slackに表示されるので、太字や表などのマークダウンは使わず、見やすいプレーンテキストで返信してください。
"""

    browser = AgentCoreBrowser()
    return Agent(
        model=BedrockModel(region_name=REGION, model_id=MODEL_ID),
        system_prompt=system_prompt,
        tools=[browser.browser, check_availability],
    )


# AgentCore Runtimeの入口で、Slack本文をそのままAgentへ渡す
@app.entrypoint
def invoke(payload: dict[str, Any] | None, context: Any = None) -> dict[str, str]:
    payload = payload or {}
    prompt = payload.get("prompt") or payload.get("text") or ""
    if not prompt:
        return {"message": "日程調整ページのURLを含めて依頼してください。"}

    agent = create_agent()
    result = agent(prompt)
    return {"message": str(result)}


if __name__ == "__main__":
    app.run()
```

`create_agent()` で毎回 Agent を作っているのは、Slack の別スレッドの会話履歴を持ち越さないためです。Slack へ返す文章は、太字や表を使わないプレーンテキストにしています。

このサンプルでは、Python 側に「調整さんのこのフォーム名を探す」といったページ固有の処理を書きません。ページを開く、候補を読む、入力欄を探す、送信する、という判断は Strands Agent に任せます。Agent がブラウザ操作を必要だと判断したときに、ツールとして渡した AgentCore Browser Tool が使われます。

## Slack受信用Lambdaを作る

次に、Slack からのイベントを受ける Lambda を作ります。

Slack の Events API は、最初に `url_verification` を送ってきます。通常のイベントでは、`X-Slack-Signature` と `X-Slack-Request-Timestamp` を使って署名を検証します。

`lambda/index.ts` は少し長いので、中心部分だけ載せます。

```ts
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";

const agentcore = new BedrockAgentCoreClient({
  region: process.env.AWS_REGION ?? "ap-northeast-1",
});
const lambda = new LambdaClient({
  region: process.env.AWS_REGION ?? "ap-northeast-1",
});

type WorkItem = {
  type: "run_agent";
  channel: string;
  threadTs: string;
  sessionId: string;
  text: string;
};

// Slack Events APIのapp_mentionをAgentCore Runtimeに中継する
export async function handler(event: any) {
  if (event.type === "run_agent") {
    return runAgent(event);
  }

  const bodyText = event.isBase64Encoded
    ? Buffer.from(event.body ?? "", "base64").toString("utf8")
    : event.body ?? "{}";

  if (findHeader(event.headers ?? {}, "x-slack-retry-num")) {
    return { statusCode: 200, body: "retry ignored" };
  }

  if (!verifySlackRequest(event.headers ?? {}, bodyText)) {
    return { statusCode: 401, body: "invalid signature" };
  }

  const body = JSON.parse(bodyText);
  if (body.type === "url_verification") {
    return { statusCode: 200, headers: { "content-type": "text/plain" }, body: body.challenge };
  }
  if (!matchesExpected(body.team_id, process.env.SLACK_TEAM_ID)) {
    return { statusCode: 403, body: "unexpected team" };
  }

  const slackEvent = body.event;
  if (body.type === "event_callback" && slackEvent?.type === "app_mention") {
    if (!matchesExpected(slackEvent.channel, process.env.SLACK_CHANNEL_ID)) {
      return { statusCode: 403, body: "unexpected channel" };
    }

    const threadTs = slackEvent.thread_ts ?? slackEvent.ts;
    const sessionId = `${body.team_id}_${slackEvent.channel}_${threadTs}_${slackEvent.user}`.replace(/[^A-Za-z0-9_.-]/g, "_");

    await postSlack(slackEvent.channel, threadTs, "数分かかるので、終わったらレスしますね！");
    try {
      await enqueueWork({
        type: "run_agent",
        channel: slackEvent.channel,
        threadTs,
        sessionId,
        text: slackEvent.text ?? "",
      });
    } catch (error) {
      console.error(error);
      await postSlack(slackEvent.channel, threadTs, "処理開始に失敗しました。Lambdaのログを確認してください。");
    }
  }

  return { statusCode: 200, body: "ok" };
}

// Slackへ即応答したあと、非同期呼び出しでAgentCore Runtimeを実行する
async function enqueueWork(item: WorkItem) {
  await lambda.send(
    new InvokeCommand({
      FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME,
      InvocationType: "Event",
      Payload: Buffer.from(JSON.stringify(item)),
    })
  );
}

// AgentCore Runtimeの結果をSlackスレッドへ投稿する
async function runAgent(item: WorkItem) {
  console.log("run_agent started", { sessionId: item.sessionId, channel: item.channel, threadTs: item.threadTs });
  try {
    const result = await invokeRuntime(item.sessionId, item.text);
    await postSlack(item.channel, item.threadTs, result.message ?? JSON.stringify(result));
    console.log("run_agent completed", { sessionId: item.sessionId });
  } catch (error) {
    console.error(error);
    await postSlack(item.channel, item.threadTs, "処理に失敗しました。Lambdaのログを確認してください。");
    return { ok: false };
  }

  return { ok: true };
}

// Slack本文をAgentCore Runtimeのpromptとして渡す
async function invokeRuntime(sessionId: string, prompt: string) {
  const response = await agentcore.send(
    new InvokeAgentRuntimeCommand({
      agentRuntimeArn: process.env.AGENT_RUNTIME_ARN!,
      runtimeSessionId: sessionId,
      qualifier: "DEFAULT",
      contentType: "application/json",
      accept: "application/json",
      payload: Buffer.from(JSON.stringify({ session_id: sessionId, prompt })),
    })
  );
  const text = await responseBodyText(response.response);
  console.log("agent_runtime response received", { sessionId, bytes: Buffer.byteLength(text, "utf8") });
  return JSON.parse(text);
}

// ... responseBodyText、postSlack、verifySlackRequestなどは省略
```

`enqueueWork` では、同じ Lambda を非同期に呼び出しています。Slack には先に 200 を返し、時間のかかる AgentCore Runtime 呼び出しは後続処理に回します。

署名検証、Slack への投稿、AgentCore Runtime のレスポンス変換、ヘッダー取得、team / channel の照合は、[GitHub リポジトリ][sample-code-repo]側に置きます。署名検証では、JSON に変換する前の raw body を使います。詳しくは [Verifying requests from Slack](https://docs.slack.dev/authentication/verifying-requests-from-slack/) を確認してください。

実際のコードでは、`SLACK_TEAM_ID` と `SLACK_CHANNEL_ID` のガードも入れています。検証中の Bot が、意図しない workspace や channel で反応しないようにするためです。

Slack はイベント受信側に素早い 2xx 応答を期待します。今回は同じ Lambda を非同期に呼び直し、SQS などを増やさずにその制約へ対応します。

## CDKでまとめてデプロイする

CDK では、AgentCore Runtime と Slack受信用 Lambda を同じスタックに置きます。

`infra/cdk.ts` の役割は4つです。

- `runtime/` を AgentCore Runtime としてデプロイする
- `lambda/index.ts` を Lambda Function URL として公開する
- Lambda から Runtime を呼べる IAM 権限を付ける
- Lambda が自分自身を非同期に呼べる IAM 権限を付ける

主要部分を抜き出すと、次のようになります。

```ts
// ... importや環境変数チェック関数は省略

// AgentCore RuntimeとSlack受信用Lambdaをデプロイする
class ChoseiAgentStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // runtime/ をAgentCore Runtimeのコンテナとしてデプロイする
    const runtime = new Runtime(this, 'Runtime', {
      runtimeName: 'ChoseiAgent',
      agentRuntimeArtifact: AgentRuntimeArtifact.fromAsset(path.join(__dirname, '../../runtime')),
      protocolConfiguration: ProtocolType.HTTP,
      environmentVariables: runtimeEnvironment(Stack.of(this).region),
    });

    // AgentCore Browser Toolを使うため、検証ではRuntimeへ広めのAgentCore権限を付ける
    runtime.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock-agentcore:*'],
        resources: ['*'],
      })
    );

    // Strands AgentからBedrockモデルを呼び出すための権限を付ける
    runtime.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: ['arn:aws:bedrock:*::foundation-model/*', 'arn:aws:bedrock:*:*:inference-profile/*'],
      })
    );

    // lambda/index.ts をSlack Events APIの受け口として公開する
    const slackAdapter = new NodejsFunction(this, 'SlackAdapter', {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.join(__dirname, '../../lambda', 'index.ts'),
      projectRoot: path.join(__dirname, '../..'),
      depsLockFilePath: path.join(__dirname, '../../package-lock.json'),
      handler: 'handler',
      timeout: Duration.minutes(10),
      environment: lambdaEnvironment(runtime.agentRuntimeArn),
      bundling: {
        externalModules: [],
      },
    });

    // Slack受信用LambdaからAgentCore Runtimeを呼べるようにする
    slackAdapter.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock-agentcore:InvokeAgentRuntime'],
        resources: [runtime.agentRuntimeArn, `${runtime.agentRuntimeArn}/runtime-endpoint/*`],
      })
    );
    // Slackへ即応答したあと、同じLambdaを非同期に呼び出してAgent処理を続ける
    slackAdapter.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [
          Stack.of(this).formatArn({
            arnFormat: ArnFormat.COLON_RESOURCE_NAME,
            service: 'lambda',
            resource: 'function',
            resourceName: `${Stack.of(this).stackName}-SlackAdapter*`,
          }),
        ],
      })
    );

    // Slack AppのEvent Subscriptionsに登録するHTTPSエンドポイントを作る
    const slackAdapterUrl = slackAdapter.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
    });

    // ... CfnOutputやapp作成は省略
  }
}
```

実際の `infra/cdk.ts` には、このほかに必須環境変数を確認する関数、Runtime / Lambda へ渡す環境変数を組み立てる関数、CloudFormation Output なども入っています。

検証を短く進めるため、Browser Tool まわりの Runtime 権限は広めにしています。本番に近づけるときは、CloudTrail や実行ログを見ながら必要な action に絞ってください。

## Google Calendarの認証情報を用意する

ここから外部サービスの設定に移ります。

Google Calendar は予定の読み取りだけに使います。Google Cloud Console では、次の順で進めます。

細かい画面操作は [Google Calendar API Python Quickstart](https://developers.google.com/workspace/calendar/api/quickstart/python) に任せます。ここでは、今回必要な作業だけを書きます。

1. Google Cloud Console で検証用プロジェクトを作る、または既存プロジェクトを選びます。
2. Google Calendar API を有効化します。
3. Google Auth platform の Branding を最低限設定します。
4. OAuth client を作ります。Application type は Desktop app を選びます。
5. `credentials.json` をダウンロードします。
6. Google Calendar API の Python Quickstart と同じ流れで認可し、`token.json` を作ります。

個人の Gmail アカウントで試す場合は、OAuth 同意画面をテスト公開のままにして、自分の Google アカウントをテストユーザーに入れておけば進められます。組織の Google Workspace で試す場合は、組織のポリシーに従ってください。

使う scope は読み取り専用です。

```text
https://www.googleapis.com/auth/calendar.readonly
```

`token.json` から、後で使う値を控えます。

```text
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_REFRESH_TOKEN
```

読みたいカレンダーがメインカレンダーなら、`GOOGLE_CALENDAR_ID` は `primary` で構いません。

refresh token は秘密情報です。記事の検証では環境変数で渡しますが、チームで使うなら Secrets Manager などへ移してください。

## Slack Appを作る

Slack 側では、Bot がメンションされたときだけ Lambda にイベントを送る App を作ります。

[Slack API の Your Apps](https://api.slack.com/apps) から、検証用 workspace に App を作ります。イベント設定の考え方は [Slack Events API](https://docs.slack.dev/apis/events-api/) も参照してください。最初に触るのは次の項目です。

1. App を From scratch で作ります。
2. OAuth & Permissions で Bot Token Scopes に `app_mentions:read` と `chat:write` を追加します。
3. App を workspace にインストールし、Bot User OAuth Token を控えます。
4. Basic Information で Signing Secret を控えます。
5. 投稿先にしたい Slack チャンネルへ Bot を招待します。

Event Subscriptions の Request URL は、CDK デプロイ後に出力される Lambda Function URL を入れます。この時点では、まだ空のままで構いません。

控える値はこの4つです。

```text
SLACK_SIGNING_SECRET
SLACK_BOT_TOKEN
SLACK_TEAM_ID
SLACK_CHANNEL_ID
```

`SLACK_TEAM_ID` は Bot Token で `auth.test` を呼ぶと確認できます。

```sh
curl -H "Authorization: Bearer $SLACK_BOT_TOKEN" https://slack.com/api/auth.test
```

`SLACK_CHANNEL_ID` は、Slack のチャンネル詳細やチャンネルリンクから確認できます。必須ではありませんが、検証中は指定しておくのがおすすめです。想定外のチャンネルで Bot が反応するのを防げます。

## デプロイする

必要な値を環境変数に入れます。`...` の部分は、それぞれ自分の値に置き換えてください。

```sh
export AWS_REGION="ap-northeast-1"

export GOOGLE_CLIENT_ID="..."
export GOOGLE_CLIENT_SECRET="..."
export GOOGLE_REFRESH_TOKEN="..."
export GOOGLE_CALENDAR_ID="primary"
export SCHEDULING_DISPLAY_NAME="みのるん"

export SLACK_SIGNING_SECRET="..."
export SLACK_BOT_TOKEN="xoxb-..."
export SLACK_TEAM_ID="T..."
export SLACK_CHANNEL_ID="C..."
```

初めてその AWS アカウントとリージョンで CDK を使う場合は、bootstrap を実行します。詳しい意味を確認したい場合は [AWS CDK の bootstrap ドキュメント](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping-env.html) を見てください。

```sh
npx cdk bootstrap
```

続けて、ビルドしてデプロイします。

```sh
npm run build
npx cdk deploy
```

デプロイが終わると、`SlackAdapterUrl` が出力されます。この URL を Slack App の Event Subscriptions にある Request URL へ設定します。Slack 側で URL verification が成功したら、Bot Events に `app_mention` を追加し、App を再インストールします。

## 動かしてみる

Slack の投稿先チャンネルに Bot を招待してから、日程調整ページの URL を投げます。

```text
@chosei-agent https://example.com/schedule/...
```

最初に「数分かかるので、終わったらレスしますね！」と返ってくれば、Slack から Lambda までは届いています。その後、Runtime 上の Strands Agent が Browser Tool と `check_availability` を使って結果を返します。

外部サイトへ書き込むエージェントなので、最初のライブ検証だけは慎重に進めます。AWS アカウント、Google アカウント、Slack workspace、Slack channel、日程調整 URL、入力する表示名を確認してから動かしてください。

## 迷うときだけ聞く

確認ボタンを毎回出すと、せっかくの小さな自動化が重くなります。今回は system prompt に、迷わない場合は送信してよい、迷う場合だけ質問する、と書きます。

迷う場合は、たとえば次のようなケースです。

- 日程調整ページの URL が見つからない
- 複数の URL があり、どれを入力するか分からない
- 候補日を日時として解釈できない
- Google カレンダーを読めない

この線引きは、Python の分岐ではなく Agent への指示として持たせます。確認ボタン用の分岐を増やさないので、Runtime のコードは短く保てます。

## 試して分かったこと

この題材で AgentCore を使ってみると、Lambda と Runtime の分け方がかなり効くと感じました。

Slack の都合は Lambda に閉じ込める。候補日の取得、カレンダー確認、出欠案の作成、必要なら聞き返す判断は Runtime 側に置く。こうしておくと、Slack 以外の入口を足したくなっても、日程調整の本体はそのまま使えます。

もう1つ感じたのは、AI に任せる範囲を広げすぎない方が扱いやすいということです。出欠判定は `check_availability` の結果を見る。Slack には予定タイトルを出さない。迷うときだけユーザーに聞く。このくらいに絞ると、日常タスクでも安心して使いやすくなります。

大きな業務システムを作る前に、こういう小さいアンビエントエージェントを1つ作ってみる。AgentCore の使いどころは、そのくらいの日常タスクから見えてくる気がします。

[sample-code-repo]: https://github.com/minorun365/chosei-agent
