"""Offline channel research contract: no account, network, SQLite or real sleep."""
import asyncio
import importlib.util
import sys
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from telethon import types, functions, errors

directory = Path(__file__).parents[1] / "workers"
sys.path.insert(0, str(directory))
from personal_radar_connectors.telegram import worker as base
base.MONITORING_FILTERS={"excludeKeywords":["blocked test phrase"]}
from telegram_research import command_research, validate_input

stamp = datetime(2026, 10, 1, 10, tzinfo=timezone.utc)
chat = types.Channel(id=1, title="Test", photo=types.ChatPhotoEmpty(), date=stamp,
                     username="testchannel", megagroup=True, forum=True)
def message(id, **kwargs):
    return types.Message(id=id, peer_id=types.PeerChannel(1), date=stamp, message="Открытая встреча с подробным описанием времени, места и условий участия.", **kwargs)

class FakeClient:
    def __init__(self, replies, source=chat, linked=None, history=None):
        self.replies, self.requests, self.disconnected = list(replies), [], False
        self.source, self.linked, self.history, self.history_requests = source, linked, list(history or []), []
    async def get_entity(self, username):
        if isinstance(username, types.PeerChannel):
            assert self.linked is not None and username.channel_id == self.linked.id
            return self.linked
        return self.source
    async def __call__(self, request):
        self.requests.append(request)
        value = self.replies.pop(0)
        if isinstance(value, Exception): raise value
        return value
    async def get_messages(self, peer, **kwargs):
        assert self.history, "Unexpected history read"
        self.history_requests.append((peer, kwargs))
        return self.history.pop(0)
    async def disconnect(self): self.disconnected = True

async def noop(*args, **kwargs): pass
async def run(mode, replies, source=chat, linked=None, history=None, **kwargs):
    client = FakeClient(replies, source, linked, history)
    with patch.object(base, "client", return_value=client), patch.object(base, "ensure_authorized", noop), \
         patch.object(base, "protect_session"), patch.object(base.asyncio, "sleep", noop):
        result = await command_research({"mode": mode, "channels": ["testchannel"], "pageSize": 10,
                                         "excludeKeywords": [], **kwargs}, base)
    assert client.disconnected
    return result, client.requests + client.history_requests

def page(messages, count=None):
    return SimpleNamespace(messages=messages, **({"count": count} if count is not None else {}))

def topic(id, title, top, **kwargs):
    return types.ForumTopic(id=id, date=stamp, peer=types.PeerChannel(1), title=title,
        icon_color=0, top_message=top, read_inbox_max_id=0, read_outbox_max_id=0,
        unread_count=0, unread_mentions_count=0, unread_reactions_count=0,
        unread_poll_votes_count=0, from_id=types.PeerUser(7), notify_settings=types.PeerNotifySettings(), **kwargs)

async def tests():
    old = message(1, pinned=True); old.date = datetime(2020, 1, 1, tzinfo=timezone.utc)
    old.message = "#реклама правила группы " + "подробные правила " * 4  # common ad policy also applies to pins
    result, requests = await run("pinned", [page([old], 1)])
    row = result["channels"][0]
    assert row["posts"] == [] and not row["truncated"]
    assert isinstance(requests[0], functions.messages.SearchRequest)
    assert isinstance(requests[0].filter, types.InputMessagesFilterPinned)
    assert requests[0].q == "" and requests[0].min_date is None and requests[0].max_date is None
    assert result["requestCount"] == 2 and not result["billing"]["paidStarsAllowed"]

    result, requests = await run("pinned", [page([message(9), message(8), message(7)], 3)], maxMessagesPerChannel=2)
    assert result["channels"][0]["truncated"] and result["channels"][0]["nextBeforeMessageId"] == "8"
    result, requests = await run("pinned", [page([message(7)], 3)], beforeMessageIds={"testchannel": "8"})
    assert requests[0].offset_id == 8 and not result["channels"][0]["truncated"]
    result, requests = await run("search", [page([message(10)], 1)], query="поход",
                                 startDate="2026-10-01", endDate="2026-10-01", topicId="42")
    request = requests[0]
    assert request.q == "поход" and isinstance(request.filter, types.InputMessagesFilterEmpty)
    assert request.peer is chat and request.top_msg_id == 42
    assert request.max_date.isoformat() == "2026-10-01T22:00:00+00:00"
    assert result["channels"][0]["returnedCount"] == 1
    # Service messages and hidden ads must still advance pagination.
    service = types.MessageService(id=20, peer_id=types.PeerChannel(1), date=stamp, action=types.MessageActionPinMessage())
    result, requests = await run("search", [page([service] + [message(i) for i in range(19, 10, -1)], 11), page([message(10)], 11)], query="поход")
    assert requests[1].offset_id == 11 and result["channels"][0]["filteredCount"] == 1
    result, _ = await run("search", [page([], 0)], query="нет результатов")
    assert not result["channels"][0]["truncated"] and result["channels"][0]["returnedCount"] == 0

    full = SimpleNamespace(about="Русскоязычные прогулки", participants_count=5515, linked_chat_id=2, pinned_msg_id=99)
    linked = types.Channel(id=2, title="Discussion", photo=types.ChatPhotoEmpty(), date=stamp, username="linkedchat", megagroup=True)
    result, requests = await run("info", [SimpleNamespace(full_chat=full, chats=[chat, linked])], minParticipants=500)
    assert isinstance(requests[0], functions.channels.GetFullChannelRequest)
    row = result["channels"][0]
    assert row["passesMinParticipants"] and row["description"] == full.about and row["isForum"]
    assert row["linkedChat"]["url"] == "https://t.me/linkedchat" and row["latestPinnedMessageId"] == "99"
    full.participants_count = 499
    result, _ = await run("info", [SimpleNamespace(full_chat=full, chats=[])], minParticipants=500)
    assert result["channels"][0]["passesMinParticipants"] is False
    full.participants_count = None
    result, _ = await run("info", [SimpleNamespace(full_chat=full, chats=[])], minParticipants=500)
    assert result["channels"][0]["passesMinParticipants"] is None

    # Topic discovery uses a bounded RPC, never scans the group's history.
    result, requests = await run("topics", [SimpleNamespace(topics=[topic(42, "AI митапы", 98, pinned=True),
        topic(43, "Вакансии", 97, closed=True)], messages=[message(98), message(97)], count=8)], maxTopicsPerChannel=2)
    row = result["channels"][0]
    assert row["truncated"] and row["nextCursor"]["offsetTopic"] == 43
    assert row["topics"][0]["title"] == "AI митапы" and row["topics"][1]["closed"]
    assert isinstance(requests[0], functions.messages.GetForumTopicsRequest) and requests[0].limit == 2
    cursor = row["nextCursor"]
    result, requests = await run("topics", [SimpleNamespace(topics=[], messages=[], count=8)],
        topicCursors={"@TESTCHANNEL": cursor}, query="митап")
    assert requests[0].offset_topic == 43 and requests[0].offset_id == 97 and requests[0].q == "митап"
    plain = types.Channel(id=1, title="Plain", photo=types.ChatPhotoEmpty(), date=stamp, username="testchannel", megagroup=True)
    result, requests = await run("topics", [], source=plain)
    assert not result["channels"][0]["isForum"] and not requests and result["requestCount"] == 1

    # Selected topic replies are excluded by the common policy.
    reply = message(99, reply_to=types.MessageReplyHeader(reply_to_msg_id=42, forum_topic=True))
    ad = message(98); ad.message = "#реклама рассылка"
    result, requests = await run("topic_posts", [page([reply, ad], 2)], topicId="42", excludeReplies=True)
    assert isinstance(requests[0], functions.messages.GetRepliesRequest) and requests[0].msg_id == 42
    assert result["channels"][0]["returnedCount"] == 0
    # Context pagination advances across service messages and returns a safe cursor.
    result, requests = await run("topic_posts", [page([service] + [message(i) for i in range(19, 10, -1)], 11),
        page([message(10)], 11)], topicId="42", maxMessagesPerChannel=10)
    assert requests[1].offset_id == 11 and result["channels"][0]["filteredCount"] == 1
    result, _ = await run("topic_posts", [page([message(9), message(8), message(7)], 3)], topicId="42", maxMessagesPerChannel=2)
    assert result["channels"][0]["nextBeforeMessageId"] == "8"
    other = message(90, reply_to=types.MessageReplyHeader(reply_to_msg_id=42, forum_topic=True))
    result, requests = await run("topic_posts", [], topicId="1", history=[[other, message(89)]])
    assert isinstance(requests[0], tuple) and result["channels"][0]["filterBreakdown"] == {"otherTopic": 1}
    assert [post["id"] for post in result["channels"][0]["posts"]] == ["89"]

    # Linked discussion is resolved only from an authoritative source-channel linkage.
    source = types.Channel(id=1, title="Source", photo=types.ChatPhotoEmpty(), date=stamp, username="testchannel", broadcast=True)
    full.linked_chat_id = None
    result, requests = await run("linked_posts", [SimpleNamespace(full_chat=full, chats=[])], source=source)
    assert result["channels"][0]["status"] == "noLinkedChat" and len(requests) == 1
    full.linked_chat_id = 2
    full_result = SimpleNamespace(full_chat=full, chats=[source, linked])
    for exclusion in [{"excludedUsernames": ["linkedchat"]}, {"excludedChannelIds": ["2"]}]:
        result, requests = await run("linked_posts", [full_result], source=source, **exclusion)
        assert result["channels"][0]["status"] == "linkedChatExcluded" and len(requests) == 1
    private = types.Channel(id=2, title="Private discussion", photo=types.ChatPhotoEmpty(), date=stamp, megagroup=True)
    private_full = SimpleNamespace(full_chat=full, chats=[source, private])
    reply.peer_id = types.PeerChannel(2)
    result, requests = await run("linked_posts", [private_full], source=source, linked=private, history=[[reply]])
    row = result["channels"][0]
    assert row["channel"]["id"] == "2" and row["sourceChannel"]["id"] == "1"
    assert row["posts"] == [] and row["status"] == "available"

    # A channel post and the auto-forwarded chat root have DIFFERENT IDs.
    root = types.Message(id=700, peer_id=types.PeerChannel(2), date=stamp, message="Анонс",
        fwd_from=types.MessageFwdHeader(date=stamp, from_id=types.PeerChannel(1), channel_post=25))
    result, requests = await run("comments", [full_result, page([root]), page([reply], 1)],
        source=source, linked=linked, postId="25")
    row = result["channels"][0]
    assert isinstance(requests[1], functions.messages.GetDiscussionMessageRequest) and requests[1].msg_id == 25
    assert isinstance(requests[2], functions.messages.GetRepliesRequest) and requests[2].msg_id == 700 and requests[2].peer is linked
    assert row["discussionRootId"] == "700" and row["posts"] == []
    root.fwd_from.from_id = types.PeerChannel(777)
    try:
        await run("comments", [full_result, page([root])], source=source, linked=linked, postId="25")
        raise AssertionError("Wrong-source root must be rejected before reading replies")
    except base.WorkerError as exc: assert exc.code == "unavailable"

    try:
        await run("pinned", [errors.FloodWaitError(request=None, capture=12)])
        raise AssertionError("FloodWait must abort")
    except base.WorkerError as exc:
        assert exc.code == "flood_wait" and exc.details["retryAfterSeconds"] == 12
    for payload in [{"mode": "search", "query": ""}, {"mode": "pinned", "startDate": "2026-10-02", "endDate":"2026-10-01"},
                    {"mode": "search", "query": "x", "topicId": "-1"}, {"mode": "pinned", "delaySeconds": 0},
                    {"mode": "topic_posts"}, {"mode": "comments", "postId": "2147483648"},
                    {"mode": "topics", "maxTopicsPerChannel": 101},
                    {"mode": "topics", "topicCursors": {"testchannel": {"offsetId": -1}}}]:
        try:
            validate_input({"channels": ["testchannel"], **payload}, base)
            raise AssertionError("Invalid input must fail")
        except base.WorkerError: pass

asyncio.run(tests())
print("Offline research worker tests passed")
