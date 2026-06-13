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
