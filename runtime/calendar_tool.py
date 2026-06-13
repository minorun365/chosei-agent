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
