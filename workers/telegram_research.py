"""Read-only, channel-scoped research. Never invokes global/paid search."""
from __future__ import annotations

from collections import Counter
from datetime import timedelta
from typing import Any

from telethon import errors, functions, types


def validate_input(payload: Any, base: Any) -> dict[str, Any]:
    if not isinstance(payload, dict) or payload.get("mode") not in ("info", "pinned", "search", "topics", "topic_posts", "linked_posts", "comments"):
        raise base.WorkerError("Неизвестный режим research.", "invalid_input")
    mode = payload["mode"]
    query = payload.get("query", "")
    if not isinstance(query, str) or len(query.strip()) > 200 or (mode == "search" and not query.strip()):
        raise base.WorkerError("Для поиска нужен непустой query длиной до 200.", "invalid_input")
    if mode == "pinned" and any(payload.get(key) for key in ("startDate", "endDate", "query", "topicId")):
        raise base.WorkerError("Закрепы читаются без дат, query и topicId.", "invalid_input")
    max_messages = payload.get("maxMessagesPerChannel", 20)
    if not isinstance(max_messages, int) or isinstance(max_messages, bool) or not 1 <= max_messages <= 100:
        raise base.WorkerError("maxMessagesPerChannel: допустимо 1..100.", "invalid_input")
    # Reuse monitoring's normalized public targets, time zones and hard caps.
    args = base.validate_monitor_input({
        **payload, "maxPostsPerChannel": max_messages,
        "maxScannedPerChannel": payload.get("maxScannedPerChannel", 200),
    })
    minimum = payload.get("minParticipants", 0)
    if not isinstance(minimum, int) or isinstance(minimum, bool) or not 0 <= minimum <= 10_000_000:
        raise base.WorkerError("Невалидный minParticipants.", "invalid_input")
    topic = payload.get("topicId")
    if topic is not None and (not isinstance(topic, str) or not topic.isdigit() or not 0 < int(topic) <= 2_147_483_647):
        raise base.WorkerError("Невалидный topicId.", "invalid_input")
    if mode == "topic_posts" and topic is None:
        raise base.WorkerError("Нужен topicId.", "invalid_input")
    if mode in ("topic_posts", "comments") and len(args["channels"]) != 1:
        raise base.WorkerError("Выберите ровно один исходный канал/группу.", "invalid_input")
    post_id = payload.get("postId")
    if mode == "comments" and (not isinstance(post_id, str) or not post_id.isdigit() or not 0 < int(post_id) <= 2_147_483_647):
        raise base.WorkerError("Нужен положительный postId.", "invalid_input")
    max_topics = payload.get("maxTopicsPerChannel", 50)
    if not isinstance(max_topics, int) or isinstance(max_topics, bool) or not 1 <= max_topics <= 100:
        raise base.WorkerError("maxTopicsPerChannel: допустимо 1..100.", "invalid_input")
    cursors = payload.get("topicCursors", {})
    if not isinstance(cursors, dict):
        raise base.WorkerError("topicCursors должен быть object.", "invalid_input")
    normalized_cursors = {}
    for name, cursor in cursors.items():
        if not isinstance(cursor, dict) or any(not isinstance(cursor.get(key, 0), int) or isinstance(cursor.get(key, 0), bool) or
                                               not 0 <= cursor.get(key, 0) <= 2_147_483_647 for key in ("offsetId", "offsetTopic")):
            raise base.WorkerError("Невалидный курсор тем.", "invalid_input")
        if not cursor.get("offsetDate") or base.zoned_date_bound(cursor["offsetDate"], base.ZoneInfo("UTC")) is None:
            raise base.WorkerError("Нужна дата курсора тем.", "invalid_input")
        normalized_cursors[base.normalized_seed(name).casefold()] = cursor
    return {**args, "mode": mode, "query": query.strip(), "minParticipants": minimum,
            "topicId": int(topic) if topic else None, "postId": int(post_id) if post_id else None,
            "maxTopicsPerChannel": max_topics, "topicCursors": normalized_cursors,
            "excludedUsernames": payload.get("excludedUsernames", []), "excludedChannelIds": payload.get("excludedChannelIds", [])}


def contextual_channel(chat: Any, base: Any) -> dict | None:
    """Private supergroups are allowed only through the source's verified linkage."""
    public = base.channel_payload(chat)
    if public:
        return public
    if not isinstance(chat, types.Channel):
        return None
    return {"id": str(chat.id), "title": str(chat.title), "username": "", "url": f"https://t.me/c/{chat.id}",
            "broadcast": bool(chat.broadcast), "megagroup": bool(chat.megagroup), "verified": bool(chat.verified),
            "participantsCount": getattr(chat, "participants_count", None)}


def context_post(message: Any, channel: dict, base: Any) -> dict:
    post = base.monitoring_post(message, channel["username"])
    if not channel["username"]:
        post["url"] = f"https://t.me/c/{channel['id']}/{message.id}"
    return post


async def read_topics(tg: Any, chat: Any, channel: dict, args: dict, limiter: Any, base: Any) -> dict:
    row = {"channel": channel, "isForum": bool(getattr(chat, "forum", False)), "totalTopics": None,
           "topics": [], "truncated": False, "nextCursor": None}
    if not row["isForum"]:
        return row
    cursor = args["topicCursors"].get(channel["username"].casefold(), {})
    offset_date = base.zoned_date_bound(cursor.get("offsetDate"), base.ZoneInfo("UTC"))
    request = functions.messages.GetForumTopicsRequest(peer=chat, offset_date=offset_date,
        offset_id=cursor.get("offsetId", 0), offset_topic=cursor.get("offsetTopic", 0),
        limit=args["maxTopicsPerChannel"], q=args["query"] or None)
    result = await limiter.call(lambda: tg(request))
    row["totalTopics"] = getattr(result, "count", None)
    messages = {int(message.id): message for message in result.messages}
    for topic in result.topics:
        if not isinstance(topic, types.ForumTopic):
            continue
        latest = messages.get(topic.top_message)
        row["topics"].append({"id": str(topic.id), "title": topic.title,
            "pinned": bool(topic.pinned), "closed": bool(topic.closed), "hidden": bool(topic.hidden),
            "createdAt": base.iso_datetime(topic.date), "topMessageId": str(topic.top_message),
            "lastMessageDate": base.iso_datetime(getattr(latest, "date", None)),
            "url": f"https://t.me/{channel['username']}/{topic.id}"})
    if result.topics and len(result.topics) >= args["maxTopicsPerChannel"]:
        last = result.topics[-1]
        if not isinstance(last, types.ForumTopic):
            raise base.WorkerError("Невозможно построить курсор удалённой темы.", "pagination_error")
        latest = messages.get(last.top_message)
        stamp = last.date if getattr(result, "order_by_create_date", False) else getattr(latest, "date", None)
        if stamp is None:
            raise base.WorkerError("Telegram не дал дату для курсора тем.", "pagination_error")
        next_cursor = {"offsetDate": base.iso_datetime(stamp), "offsetId": int(last.top_message), "offsetTopic": int(last.id)}
        if next_cursor == cursor:
            raise base.WorkerError("Не продвигающаяся страница тем.", "pagination_error")
        row["truncated"], row["nextCursor"] = True, next_cursor
    return row


async def context_history(tg: Any, chat: Any, channel: dict, args: dict, limiter: Any, base: Any, root_id: int | None = None) -> dict:
    cursor = args["beforeMessageIds"].get(channel["username"].casefold(), args["beforeMessageIds"].get(channel["id"], 0))
    minimum = args["afterMessageIds"].get(channel["username"].casefold(), args["afterMessageIds"].get(channel["id"], 0))
    posts, filters = [], Counter()
    scanned, total, ended, last_id = 0, None, False, None
    while len(posts) < args["maxPostsPerChannel"] and scanned < args["maxScannedPerChannel"]:
        size = min(args["pageSize"], args["maxScannedPerChannel"] - scanned)
        if root_id is not None:
            request = functions.messages.GetRepliesRequest(peer=chat, msg_id=root_id, offset_id=cursor,
                offset_date=args["endDate"], add_offset=0, limit=size, max_id=0, min_id=minimum, hash=0)
            result = await limiter.call(lambda: tg(request))
            page, total = list(result.messages), getattr(result, "count", None)
        else:
            page = list(await limiter.call(lambda: tg.get_messages(chat, limit=size, offset_id=cursor,
                                                                 offset_date=args["endDate"], min_id=minimum)))
        if not page:
            ended = True
            break
        if cursor and any(int(item.id) >= cursor for item in page):
            raise base.WorkerError("Не продвигающаяся страница обсуждения.", "pagination_error")
        for message in page:
            scanned += 1
            last_id = int(message.id)
            stamp = getattr(message, "date", None)
            if args["startDate"] and stamp and stamp < args["startDate"]:
                ended = True
                break
            if not isinstance(message, types.Message):
                filters["service"] += 1
                continue
            if not isinstance(message.peer_id, types.PeerChannel) or message.peer_id.channel_id != int(channel["id"]):
                filters["otherPeer"] += 1
                continue
            post = context_post(message, channel, base)
            reply = getattr(message, "reply_to", None)
            forum_root = getattr(reply, "reply_to_top_id", None) or (getattr(reply, "reply_to_msg_id", None) if getattr(reply, "forum_topic", False) else None)
            if args["mode"] == "topic_posts" and args["topicId"] == 1 and forum_root not in (None, 1):
                reason = "otherTopic"
            elif args["endDate"] and stamp and stamp > args["endDate"]:
                reason = "afterEndDate"
            else:
                reason = base.excluded_reason(post, {**args, "excludeReplies": False})
            if reason:
                filters[reason] += 1
            else:
                posts.append(post)
            if len(posts) >= args["maxPostsPerChannel"] or scanned >= args["maxScannedPerChannel"]:
                break
        if ended:
            break
        if last_id == int(page[-1].id) and (len(page) < size or (total is not None and scanned >= total)):
            ended = True
            break
        cursor = last_id
    truncated = not ended and last_id is not None
    return {"channel": channel, "scannedCount": scanned, "returnedCount": len(posts), "filteredCount": sum(filters.values()),
            "filterBreakdown": dict(filters), "totalMatches": total, "truncated": truncated,
            "nextBeforeMessageId": str(last_id) if truncated else None, "posts": posts}


async def read_context(tg: Any, chat: Any, channel: dict, args: dict, limiter: Any, base: Any) -> dict:
    if args["mode"] == "topic_posts":
        if not getattr(chat, "forum", False):
            raise base.WorkerError("В этой группе нет форума с темами.", "invalid_input")
        # General is not a reply thread. Its bounded sample is filtered from history.
        root = None if args["topicId"] == 1 else args["topicId"]
        row = await context_history(tg, chat, channel, args, limiter, base, root)
        return {**row, "topicId": str(args["topicId"]), "sourceChannel": channel, "discussionRootId": None, "status": "available"}
    if not channel["broadcast"]:
        raise base.WorkerError("Для связанного чата/комментариев укажите исходный канал публикаций, не группу.", "invalid_input")
    info = await read_info(tg, chat, channel, args, limiter, base)
    empty = {"channel": channel, "sourceChannel": channel, "discussionRootId": None, "topicId": None,
             "scannedCount": 0, "returnedCount": 0, "filteredCount": 0, "filterBreakdown": {},
             "totalMatches": None, "truncated": False, "nextBeforeMessageId": None, "posts": []}
    linked = info["linkedChat"]
    if linked is None:
        return {**empty, "status": "noLinkedChat"}
    if linked["id"] in args["excludedChannelIds"] or (linked["username"] or "").casefold() in args["excludedUsernames"]:
        return {**empty, "status": "linkedChatExcluded"}
    # GetFullChannel already supplies accessible chat entities; no join/import.
    linked_chat = await limiter.call(lambda: tg.get_entity(types.PeerChannel(int(linked["id"]))))
    linked_channel = contextual_channel(linked_chat, base)
    if linked_channel is None or not linked_channel["megagroup"]:
        raise base.WorkerError("Связанный чат не является доступной supergroup.", "unavailable")
    if linked_channel["id"] in args["excludedChannelIds"] or linked_channel["username"].casefold() in args["excludedUsernames"]:
        return {**empty, "status": "linkedChatExcluded"}
    root = None
    if args["mode"] == "comments":
        discussion = await limiter.call(lambda: tg(functions.messages.GetDiscussionMessageRequest(peer=chat, msg_id=args["postId"])))
        roots = [message for message in discussion.messages if
                 isinstance(getattr(message, "peer_id", None), types.PeerChannel) and
                 message.peer_id.channel_id == int(linked["id"]) and
                 getattr(getattr(message, "fwd_from", None), "channel_post", None) == args["postId"] and
                 isinstance(getattr(message.fwd_from, "from_id", None), types.PeerChannel) and
                 message.fwd_from.from_id.channel_id == int(channel["id"])]
        if not roots:
            raise base.WorkerError("Не подтверждена связь поста с корнем обсуждения.", "unavailable")
        root = int(roots[-1].id)
    row = await context_history(tg, linked_chat, linked_channel, args, limiter, base, root)
    return {**row, "topicId": None, "sourceChannel": channel, "discussionRootId": str(root) if root else None, "status": "available"}


async def read_info(tg: Any, chat: Any, channel: dict, args: dict, limiter: Any, base: Any) -> dict:
    result = await limiter.call(lambda: tg(functions.channels.GetFullChannelRequest(channel=chat)))
    full = result.full_chat
    count = getattr(full, "participants_count", None)
    channel = {**channel, "participantsCount": count if count is not None else channel.get("participantsCount")}
    count = channel.get("participantsCount")
    linked_id = getattr(full, "linked_chat_id", None)
    linked = next((item for item in getattr(result, "chats", []) if item.id == linked_id), None)
    linked_username = base.public_username(linked) if linked else ""
    return {
        "channel": channel, "description": str(getattr(full, "about", "") or ""),
        "passesMinParticipants": count >= args["minParticipants"] if count is not None else None,
        "isForum": bool(getattr(chat, "forum", False)),
        "linkedChat": {"id": str(linked_id), "title": str(getattr(linked, "title", "") or ""),
                       "username": linked_username or None,
                       "url": f"https://t.me/{linked_username}" if linked_username else None} if linked_id else None,
        "latestPinnedMessageId": str(full.pinned_msg_id) if getattr(full, "pinned_msg_id", None) else None,
    }


async def read_search(tg: Any, chat: Any, channel: dict, args: dict, limiter: Any, base: Any) -> dict:
    pinned = args["mode"] == "pinned"
    cursor = args["beforeMessageIds"].get(channel["username"].casefold(), 0)
    minimum = args["afterMessageIds"].get(channel["username"].casefold(), 0)
    posts, filters = [], Counter()
    scanned, total, ended = 0, None, False
    last_id = None
    while len(posts) < args["maxPostsPerChannel"] and scanned < args["maxScannedPerChannel"]:
        size = min(args["pageSize"], args["maxScannedPerChannel"] - scanned)
        request = functions.messages.SearchRequest(
            peer=chat, q="" if pinned else args["query"],
            filter=types.InputMessagesFilterPinned() if pinned else types.InputMessagesFilterEmpty(),
            min_date=None if pinned or not args["startDate"] else args["startDate"] - timedelta(seconds=1),
            max_date=None if pinned or not args["endDate"] else args["endDate"] + timedelta(microseconds=1),
            offset_id=cursor, add_offset=0, limit=size, max_id=0, min_id=minimum, hash=0,
            top_msg_id=args["topicId"],
        )
        result = await limiter.call(lambda: tg(request))
        page = list(result.messages)
        total = getattr(result, "count", None)
        if not page:
            ended = True
            break
        if cursor and any(int(item.id) >= cursor for item in page):
            raise base.WorkerError("Telegram вернул не продвигающуюся страницу поиска.", "pagination_error")
        for item in page:
            scanned += 1
            last_id = int(item.id)
            if not isinstance(item, types.Message):
                filters["service"] += 1
            else:
                post = base.monitoring_post(item, channel["username"])
                # Pins are evidence about a community, not the filtered event feed.
                stamp = getattr(item, "date", None)
                if not pinned and stamp and ((args["startDate"] and stamp < args["startDate"]) or
                                            (args["endDate"] and stamp > args["endDate"])):
                    reason = "outsideDateRange"
                else:
                    reason = None if pinned else base.excluded_reason(post, args)
                if reason:
                    filters[reason] += 1
                else:
                    posts.append(post)
            if len(posts) >= args["maxPostsPerChannel"] or scanned >= args["maxScannedPerChannel"]:
                break
        consumed_page = last_id == int(page[-1].id)
        if consumed_page and (len(page) < size or (total is not None and scanned >= total)):
            ended = True
            break
        cursor = last_id
    truncated = not ended and last_id is not None
    return {"channel": channel, "scannedCount": scanned, "returnedCount": len(posts),
            "filteredCount": sum(filters.values()), "filterBreakdown": dict(filters),
            "totalMatches": total, "truncated": truncated,
            "nextBeforeMessageId": str(last_id) if truncated else None, "posts": posts}


async def command_research(payload: Any, base: Any) -> dict[str, Any]:
    args = validate_input(payload, base)
    tg, limiter = base.client(), base.RateLimiter(args["delaySeconds"], jitter=1.5)
    channels, warnings = [], []
    try:
        await base.ensure_authorized(tg)
        for username in args["channels"]:
            try:
                chat = await limiter.call(lambda: tg.get_entity(username))
                channel = base.channel_payload(chat)
                if channel is None:
                    warnings.append(f"@{username}: это не публичный channel/supergroup.")
                    continue
                if channel["id"] in args["excludedChannelIds"] or channel["username"].casefold() in args["excludedUsernames"]:
                    warnings.append(f"@{username}: исключённый канал после уточнения ID/username.")
                    continue
                # A renamed channel may still have a cursor under the requested name.
                for key in ("beforeMessageIds", "afterMessageIds"):
                    args[key].setdefault(channel["username"].casefold(), args[key].get(username.casefold(), 0))
                if username.casefold() in args["topicCursors"]:
                    args["topicCursors"].setdefault(channel["username"].casefold(), args["topicCursors"][username.casefold()])
                reader = read_info if args["mode"] == "info" else read_topics if args["mode"] == "topics" else read_context if args["mode"] in ("topic_posts", "linked_posts", "comments") else read_search
                channels.append(await reader(tg, chat, channel, args, limiter, base))
            except (ValueError, errors.UsernameInvalidError, errors.UsernameNotOccupiedError, errors.ChannelPrivateError) as exc:
                warnings.append(f"@{username}: канал недоступен ({exc}).")
        return {"ok": True, "mode": args["mode"], "requestCount": limiter.calls,
                "query": args["query"] or None, "channels": channels, "warnings": warnings,
                "range": {"startDate": base.iso_datetime(args["startDate"]),
                          "endDate": base.iso_datetime(args["endDate"]), "timeZone": args["timeZone"]},
                "billing": {"perResultUsd": 0, "paidStarsAllowed": False,
                            "note": "Только выбранные каналы/темы и подтверждённые связанные обсуждения; Stars не используются."}}
    except errors.FloodWaitError as exc:
        raise base.WorkerError(f"Telegram FloodWait: повторите не раньше чем через {exc.seconds} сек.",
                               "flood_wait", retryAfterSeconds=exc.seconds, completedRequests=limiter.calls) from exc
    except errors.RPCError as exc:
        raise base.WorkerError(f"Telegram RPC: {getattr(exc, 'message', None) or type(exc).__name__}",
                               "rpc_error", completedRequests=limiter.calls) from exc
    finally:
        await tg.disconnect()
        base.protect_session()
