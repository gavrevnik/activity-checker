"""Offline MTProto tests: no connection, live DB or real sleep."""
import asyncio
import importlib.util
import sys
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch
from telethon import types

from personal_radar_connectors.telegram import worker as worker
worker.MONITORING_FILTERS={"excludeKeywords":["blocked test phrase"]}
stamp = datetime(2026, 10, 1, 10, tzinfo=timezone.utc)

def message(id, text="Открытая встреча, 1000 RSD, с подробным описанием места, времени и условий участия.", **kwargs):
    return types.Message(id=id, peer_id=types.PeerChannel(1), date=stamp, message=text, **kwargs)

args = worker.validate_monitor_input({"channels": ["testchannel"]})
assert args["excludeReplies"] and args["excludeAdDisclosures"]
for text in ["#реклама", "#ad", "erid: ABC123", "на правах рекламы"]:
    assert worker.excluded_reason(worker.monitoring_post(message(1, text + " Synthetic details " * 4), "testchannel"), args) == "adDisclosure", text
for text in ["Встреча: скидка 10%, билеты 1000 RSD", "#adventure #рекламатика"]:
    assert worker.excluded_reason(worker.monitoring_post(message(1, text + " Synthetic details " * 4), "testchannel"), args) is None, text
reply = message(1, reply_to=types.MessageReplyHeader(reply_to_msg_id=9))
for text in worker.MONITORING_FILTERS["excludeKeywords"]:
    assert worker.excluded_reason(worker.monitoring_post(message(1, text.upper() + " Synthetic details " * 4), "testchannel"), args) == "keyword"
assert not worker.validate_monitor_input({"channels": ["testchannel"], "excludeKeywords": []})["excludeKeywords"]
assert worker.excluded_reason(worker.monitoring_post(reply, "testchannel"), args) == "reply"
post_with_comments = message(1, replies=types.MessageReplies(replies=20, replies_pts=1, comments=True))
assert worker.excluded_reason(worker.monitoring_post(post_with_comments, "testchannel"), args) is None

class FakeClient:
    def __init__(self, pages): self.pages, self.requests = pages, []
    async def get_entity(self, username): return object()
    async def get_messages(self, chat, **kwargs):
        self.requests.append(kwargs)
        return self.pages.pop(0)
    async def disconnect(self): pass

async def noop(*args, **kwargs): pass
async def run(pages, **kwargs):
    tg = FakeClient(pages)
    channel = {"id": "1", "username": "testchannel", "title": "Test"}
    with patch.object(worker, "client", return_value=tg), patch.object(worker, "ensure_authorized", noop), patch.object(worker, "protect_session"), patch.object(worker, "channel_payload", return_value=channel), patch.object(worker.asyncio, "sleep", noop):
        result = await worker.command_monitor({"channels": ["testchannel"], "startDate": "2026-10-01", "endDate": "2026-10-01", "pageSize": 10, **kwargs})
    return result["channels"][0], tg.requests

async def tests():
    service = types.MessageService(id=20, peer_id=types.PeerChannel(1), date=stamp, action=types.MessageActionPinMessage())
    result, requests = await run([[service] + [message(id) for id in range(19, 10, -1)], [message(10)]])
    assert len(requests) == 2 and requests[1]["offset_id"] == 11
    assert result["returnedCount"] == 10 and result["filterBreakdown"] == {"service": 1}
    assert not result["truncated"]
    result, _ = await run([[message(id) for id in [8, 7, 6, 5]]], maxPostsPerChannel=2)
    assert result["truncated"] and result["nextBeforeMessageId"] == "7"
    older = message(1); older.date = datetime(2026, 9, 30, 21, 59, tzinfo=timezone.utc)
    result, _ = await run([[message(2), older]])
    assert result["returnedCount"] == 1 and not result["truncated"]
    assert worker.validate_monitor_input({"channels": ["testchannel"], "startDate": "2026-10-01"})["startDate"].isoformat() == "2026-09-30T22:00:00+00:00"

asyncio.run(tests())
print("Offline monitoring filters and pagination passed")
