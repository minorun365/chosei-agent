import crypto from "node:crypto";
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

// AgentCore RuntimeのStreamingBlobを文字列に変換する
async function responseBodyText(body: unknown) {
  if (!body) return "{}";
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return Buffer.from(body).toString("utf8");
  if (body instanceof ArrayBuffer) return Buffer.from(body).toString("utf8");
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("utf8");
  }

  const stream = body as {
    transformToString?: () => Promise<string>;
    [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array | string>;
  };
  if (typeof stream.transformToString === "function") {
    return stream.transformToString();
  }
  if (typeof stream[Symbol.asyncIterator] === "function") {
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  throw new Error(`Unsupported AgentCore response body: ${Object.prototype.toString.call(body)}`);
}

// Agentの結果をSlackスレッドに返信する
async function postSlack(channel: string, threadTs: string, text: string) {
  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ channel, thread_ts: threadTs, text }),
  });
}

// Slack公式のv0署名をHMACで検証する
function verifySlackRequest(headers: Record<string, string>, body: string) {
  const timestamp = findHeader(headers, "x-slack-request-timestamp");
  const signature = findHeader(headers, "x-slack-signature");
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!timestamp || !signature || !secret) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 60 * 5) return false;

  const base = `v0:${timestamp}:${body}`;
  const expected = `v0=${crypto.createHmac("sha256", secret).update(base).digest("hex")}`;
  return expected.length === signature.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

// 大文字小文字の差を吸収してHTTPヘッダーを取り出す
function findHeader(headers: Record<string, string>, name: string) {
  const key = Object.keys(headers).find((item) => item.toLowerCase() === name);
  return key ? headers[key] : undefined;
}

// 環境変数が設定されたときだけteam/channelを固定する
function matchesExpected(actual: string | undefined, expected: string | undefined) {
  return !expected || actual === expected;
}
