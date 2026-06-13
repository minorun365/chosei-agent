#!/usr/bin/env node
import * as path from 'node:path';
import { App, ArnFormat, CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import { AgentRuntimeArtifact, ProtocolType, Runtime } from 'aws-cdk-lib/aws-bedrockagentcore';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';

const REQUIRED_RUNTIME_ENV_VARS = [
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REFRESH_TOKEN',
] as const;

const OPTIONAL_RUNTIME_ENV_VARS = [
  'BEDROCK_MODEL_ID',
  'GOOGLE_CALENDAR_ID',
  'SCHEDULING_DISPLAY_NAME',
] as const;

const REQUIRED_LAMBDA_ENV_VARS = ['SLACK_SIGNING_SECRET', 'SLACK_BOT_TOKEN', 'SLACK_TEAM_ID'] as const;

// 必須の環境変数をデプロイ時に確認する
function requiredEnvironment(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

// Runtimeへ渡す環境変数を作る
function runtimeEnvironment(region: string) {
  const values: Record<string, string> = {
    AGENTCORE_BROWSER_REGION: region,
  };

  for (const name of REQUIRED_RUNTIME_ENV_VARS) {
    values[name] = requiredEnvironment(name);
  }

  for (const name of OPTIONAL_RUNTIME_ENV_VARS) {
    if (process.env[name]) {
      values[name] = process.env[name]!;
    }
  }

  return values;
}

// Slack Lambdaへ渡す環境変数を作る
function lambdaEnvironment(agentRuntimeArn: string) {
  const values: Record<string, string> = {
    AGENT_RUNTIME_ARN: agentRuntimeArn,
  };

  for (const name of REQUIRED_LAMBDA_ENV_VARS) {
    values[name] = requiredEnvironment(name);
  }

  if (process.env.SLACK_CHANNEL_ID) {
    values.SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID;
  }

  return values;
}

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

    // デプロイ後にSlack設定や動作確認で使う値を出力する
    new CfnOutput(this, 'ChoseiAgentRuntimeArn', {
      value: runtime.agentRuntimeArn,
    });

    new CfnOutput(this, 'SlackAdapterUrl', {
      value: slackAdapterUrl.url,
    });
  }
}

const app = new App();

// 検証リージョンは東京を既定にする
new ChoseiAgentStack(app, 'ChoseiAgentStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.AWS_REGION ?? 'ap-northeast-1',
  },
});
