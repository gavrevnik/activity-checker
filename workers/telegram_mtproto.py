#!/usr/bin/env python3
"""Small JSON/stdio boundary around Telethon.

The HTTP server never receives a Telegram login code or 2FA password. Initial
authorization is intentionally a separate interactive CLI command. Search
commands read one JSON document from stdin and write one JSON document to
stdout so Node/MCP callers cannot accidentally parse Telethon diagnostics.
"""

from __future__ import annotations

import argparse
import asyncio
import getpass
import json
import os
import random
import re
import sys
from dataclasses import dataclass
from datetime import datetime, time, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable

from telethon import TelegramClient, errors, functions, types


OPERATIONS = (
    "searchPublicChats",
    "channels.searchPosts",
    "messages.searchGlobal",
    "channels.getChannelRecommendations",
)


class WorkerError(Exception):
    def __init__(self, message: str, code: str = "telegram_error", **details: Any):
        super().__init__(message)
        self.code = code
        self.details = details


@dataclass
class RateLimiter:
    delay: float
    calls: int = 0

    async def call(self, callback: Callable[[], Awaitable[Any]]) -> Any:
        if self.calls:
            await asyncio.sleep(self.delay + random.uniform(0, 0.75))
        self.calls += 1
        return await callback()


def credentials() -> tuple[int, str, str]:
    raw_id = os.environ.get("TELEGRAM_API_ID", "").strip()
    api_hash = os.environ.get("TELEGRAM_API_HASH", "").strip()
    session = os.environ.get("TELEGRAM_SESSION_PATH", "").strip()
    if not raw_id.isdigit() or not api_hash:
        raise WorkerError(
            "TELEGRAM_API_ID и TELEGRAM_API_HASH не найдены.",
            "missing_credentials",
        )
    if not session:
        raise WorkerError("Не задан TELEGRAM_SESSION_PATH.", "missing_session_path")
    session_path = Path(session).expanduser().resolve()
    session_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        session_path.parent.chmod(0o700)
    except OSError:
        pass
    return int(raw_id), api_hash, str(session_path)


def client() -> TelegramClient:
    api_id, api_hash, session = credentials()
    return TelegramClient(session, api_id, api_hash, flood_sleep_threshold=0)


def protect_session() -> None:
    _, _, base = credentials()
    session_file = Path(base if base.endswith(".session") else base + ".session")
    for path in (session_file, Path(str(session_file) + "-journal")):
        if path.exists():
            try:
                path.chmod(0o600)
            except OSError:
                pass


def public_username(chat: Any) -> str:
    username = getattr(chat, "username", None)
    if isinstance(username, str) and username:
        return username
    for item in getattr(chat, "usernames", None) or []:
        if getattr(item, "active", False) and getattr(item, "username", None):
            return str(item.username)
    return ""


def channel_payload(chat: Any) -> dict[str, Any] | None:
    if not isinstance(chat, types.Channel):
        return None
    username = public_username(chat)
    if not username:
        return None
    return {
        "id": str(chat.id),
        "title": str(getattr(chat, "title", "") or f"@{username}"),
        "username": username,
        "url": f"https://t.me/{username}",
        "broadcast": bool(getattr(chat, "broadcast", False)),
        "megagroup": bool(getattr(chat, "megagroup", False)),
        "verified": bool(getattr(chat, "verified", False)),
        "participantsCount": getattr(chat, "participants_count", None),
    }


def message_channel_id(message: Any) -> int | None:
    peer = getattr(message, "peer_id", None)
    if isinstance(peer, types.PeerChannel):
        return peer.channel_id
    return None


def post_payload(message: Any, chat: Any) -> dict[str, Any] | None:
    channel = channel_payload(chat)
    text = str(getattr(message, "message", "") or "").strip()
    if not channel or not text:
        return None
    date = getattr(message, "date", None)
    username = channel["username"]
    message_id = int(message.id)
    return {
        "id": str(message_id),
        "text": text[:20000],
        "date": date.astimezone(timezone.utc).isoformat() if date else None,
        "views": getattr(message, "views", None),
        "forwards": getattr(message, "forwards", None),
        "url": f"https://t.me/{username}/{message_id}",
    }


def result_key(item: dict[str, Any]) -> str:
    channel_id = item["channel"]["id"]
    post = item.get("post")
    return f"post:{channel_id}:{post['id']}" if post else f"channel:{channel_id}"


def add_result(
    results: dict[str, dict[str, Any]],
    operation: str,
    query: str,
    channel: dict[str, Any],
    post: dict[str, Any] | None,
) -> None:
    item: dict[str, Any] = {
        "kind": "post" if post else "channel",
        "operations": [operation],
        "matchedQueries": [query] if query else [],
        "channel": channel,
    }
    if post:
        item["post"] = post
    key = result_key(item)
    current = results.get(key)
    if not current:
        results[key] = item
        return
    current["operations"] = list(
        dict.fromkeys([*current["operations"], operation])
    )
    if query:
        current["matchedQueries"] = list(
            dict.fromkeys([*current["matchedQueries"], query])
        )


def normalized_seed(value: str) -> str:
    seed = value.strip()
    match = re.match(r"^https?://(?:www\.)?t\.me/(?:s/)?([A-Za-z0-9_]{5,})/?", seed)
    if match:
        return match.group(1)
    return seed.lstrip("@")


def date_bound(value: Any, end: bool = False) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if len(value) == 10:
            parsed = datetime.combine(parsed.date(), time.max if end else time.min)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except ValueError as exc:
        raise WorkerError(f"Некорректная дата: {value}", "invalid_input") from exc


def validate_search_input(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise WorkerError("Ожидается JSON object.", "invalid_input")
    queries = []
    for raw in payload.get("queries", []):
        if not isinstance(raw, str):
            raise WorkerError("queries должны быть строками.", "invalid_input")
        query = raw.strip()
        if query and query not in queries:
            queries.append(query)
    seeds = []
    for raw in payload.get("seedChannels", []):
        if not isinstance(raw, str):
            raise WorkerError("seedChannels должны быть строками.", "invalid_input")
        seed = normalized_seed(raw)
        if seed and seed not in seeds:
            seeds.append(seed)
    operations = list(dict.fromkeys(payload.get("operations", [])))
    if not operations or any(operation not in OPERATIONS for operation in operations):
        raise WorkerError("Не выбраны поддерживаемые MTProto-операции.", "invalid_input")
    if len(queries) > 30 or any(len(query) > 200 for query in queries):
        raise WorkerError("Допустимо до 30 запросов длиной до 200 символов.", "invalid_input")
    if len(seeds) > 20 or any(len(seed) > 200 for seed in seeds):
        raise WorkerError("Допустимо до 20 seed-каналов.", "invalid_input")
    query_operations = set(operations) - {"channels.getChannelRecommendations"}
    if query_operations and not queries:
        raise WorkerError("Для поисковых операций нужны keywords.", "invalid_input")
    per_query = int(payload.get("resultsPerQuery", 10))
    max_items = int(payload.get("maxItems", 100))
    min_participants = int(payload.get("minParticipants", 0))
    delay = float(payload.get("delaySeconds", 2.5))
    if not 1 <= per_query <= 50 or not 1 <= max_items <= 500:
        raise WorkerError("Лимиты вне допустимого диапазона.", "invalid_input")
    if not 0 <= min_participants <= 10_000_000:
        raise WorkerError("Порог аудитории вне допустимого диапазона.", "invalid_input")
    if not 2 <= delay <= 30:
        raise WorkerError("Пауза должна быть от 2 до 30 секунд.", "invalid_input")
    return {
        "queries": queries,
        "seedChannels": seeds,
        "operations": operations,
        "resultsPerQuery": per_query,
        "maxItems": max_items,
        "minParticipants": min_participants,
        "delaySeconds": delay,
        "minDate": date_bound(payload.get("minDate")),
        "maxDate": date_bound(payload.get("maxDate"), True),
    }


def validate_sample_input(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise WorkerError("Ожидается JSON object.", "invalid_input")
    channels = []
    for raw in payload.get("channels", []):
        if not isinstance(raw, str):
            raise WorkerError("channels должны быть строками.", "invalid_input")
        channel = normalized_seed(raw)
        if channel and channel not in channels:
            channels.append(channel)
    limit = int(payload.get("messagesPerChannel", 3))
    delay = float(payload.get("delaySeconds", 2.5))
    if not channels or len(channels) > 20:
        raise WorkerError("Допустимо от 1 до 20 публичных каналов.", "invalid_input")
    if not 1 <= limit <= 10:
        raise WorkerError("Допустимо от 1 до 10 постов на канал.", "invalid_input")
    if not 2 <= delay <= 30:
        raise WorkerError("Пауза должна быть от 2 до 30 секунд.", "invalid_input")
    return {
        "channels": channels,
        "messagesPerChannel": limit,
        "delaySeconds": delay,
    }


async def ensure_authorized(tg: TelegramClient) -> None:
    await tg.connect()
    if not await tg.is_user_authorized():
        raise WorkerError(
            "Telegram-сессия не авторизована. Выполните npm run telegram:auth.",
            "authorization_required",
        )


async def search_public_chats(
    tg: TelegramClient,
    query: str,
    limit: int,
    limiter: RateLimiter,
) -> list[tuple[dict[str, Any], None]]:
    found = await limiter.call(
        lambda: tg(functions.contacts.SearchRequest(q=query, limit=limit))
    )
    return [
        (channel, None)
        for chat in found.chats
        if (channel := channel_payload(chat)) is not None
    ]


async def search_posts(
    tg: TelegramClient,
    query: str,
    limit: int,
    limiter: RateLimiter,
    min_date: datetime | None,
    max_date: datetime | None,
) -> list[tuple[dict[str, Any], dict[str, Any]]]:
    hashtag = query[1:] if query.startswith("#") and " " not in query else None
    found = await limiter.call(
        lambda: tg(
            functions.channels.SearchPostsRequest(
                offset_rate=0,
                offset_peer=types.InputPeerEmpty(),
                offset_id=0,
                limit=limit,
                hashtag=hashtag,
                query=None if hashtag else query,
                # Deliberately omit allow_paid_stars: tools never approve a charge.
            )
        )
    )
    chats = {chat.id: chat for chat in found.chats}
    output = []
    for message in found.messages:
        chat = chats.get(message_channel_id(message))
        post = post_payload(message, chat)
        if not post:
            continue
        stamp = date_bound(post.get("date"))
        if min_date and stamp and stamp < min_date:
            continue
        if max_date and stamp and stamp > max_date:
            continue
        channel = channel_payload(chat)
        if channel:
            output.append((channel, post))
    return output


async def search_global(
    tg: TelegramClient,
    query: str,
    limit: int,
    limiter: RateLimiter,
    min_date: datetime | None,
    max_date: datetime | None,
) -> list[tuple[dict[str, Any], dict[str, Any]]]:
    found = await limiter.call(
        lambda: tg(
            functions.messages.SearchGlobalRequest(
                q=query,
                filter=types.InputMessagesFilterEmpty(),
                min_date=min_date,
                max_date=max_date,
                offset_rate=0,
                offset_peer=types.InputPeerEmpty(),
                offset_id=0,
                limit=limit,
            )
        )
    )
    chats = {chat.id: chat for chat in found.chats}
    output = []
    for message in found.messages:
        chat = chats.get(message_channel_id(message))
        channel = channel_payload(chat)
        post = post_payload(message, chat)
        if channel and post:
            output.append((channel, post))
    return output


async def recommendations(
    tg: TelegramClient,
    seeds: list[str],
    limit: int,
    limiter: RateLimiter,
) -> list[tuple[str, dict[str, Any], None]]:
    resolved: list[tuple[str, Any]] = []
    if seeds:
        for seed in seeds:
            entity = await limiter.call(lambda seed=seed: tg.get_input_entity(seed))
            if not isinstance(entity, types.InputChannel):
                continue
            resolved.append((seed, entity))
    else:
        resolved.append(("", None))
    output = []
    for seed, entity in resolved:
        found = await limiter.call(
            lambda entity=entity: tg(
                functions.channels.GetChannelRecommendationsRequest(
                    channel=entity
                )
            )
        )
        for chat in found.chats[:limit]:
            channel = channel_payload(chat)
            if channel:
                output.append((seed, channel, None))
    return output


async def command_status() -> dict[str, Any]:
    tg = client()
    try:
        await tg.connect()
        authorized = await tg.is_user_authorized()
        account = None
        if authorized:
            me = await tg.get_me()
            account = {
                "id": str(me.id),
                "username": getattr(me, "username", None),
                "name": " ".join(
                    item
                    for item in [
                        str(getattr(me, "first_name", "") or "").strip(),
                        str(getattr(me, "last_name", "") or "").strip(),
                    ]
                    if item
                ),
            }
        return {"ok": True, "authorized": authorized, "account": account}
    finally:
        await tg.disconnect()
        protect_session()


async def command_authorize() -> dict[str, Any]:
    tg = client()
    try:
        await tg.connect()
        if not await tg.is_user_authorized():
            phone = input("Номер Telegram в международном формате (+...): ").strip()
            if not phone:
                raise WorkerError("Номер не введён.", "authorization_cancelled")
            sent = await tg.send_code_request(phone)
            code = getpass.getpass("Код из Telegram (не отображается): ").strip()
            try:
                await tg.sign_in(phone=phone, code=code, phone_code_hash=sent.phone_code_hash)
            except errors.SessionPasswordNeededError:
                password = getpass.getpass("Пароль Telegram 2FA (не отображается): ")
                await tg.sign_in(password=password)
        me = await tg.get_me()
        return {
            "ok": True,
            "authorized": True,
            "account": {
                "id": str(me.id),
                "username": getattr(me, "username", None),
                "name": " ".join(
                    item
                    for item in [
                        str(getattr(me, "first_name", "") or "").strip(),
                        str(getattr(me, "last_name", "") or "").strip(),
                    ]
                    if item
                ),
            },
        }
    finally:
        await tg.disconnect()
        protect_session()


async def command_search(payload: Any) -> dict[str, Any]:
    args = validate_search_input(payload)
    tg = client()
    limiter = RateLimiter(args["delaySeconds"])
    results: dict[str, dict[str, Any]] = {}
    warnings: list[str] = []
    try:
        await ensure_authorized(tg)
        for operation in args["operations"]:
            if len(results) >= args["maxItems"]:
                break
            if operation == "channels.getChannelRecommendations":
                found = await recommendations(
                    tg, args["seedChannels"], args["resultsPerQuery"], limiter
                )
                for seed, channel, post in found:
                    count = channel.get("participantsCount")
                    if count is not None and count < args["minParticipants"]:
                        continue
                    add_result(results, operation, seed, channel, post)
                    if len(results) >= args["maxItems"]:
                        break
                continue
            for query in args["queries"]:
                if operation == "searchPublicChats":
                    found = await search_public_chats(
                        tg, query, args["resultsPerQuery"], limiter
                    )
                elif operation == "channels.searchPosts":
                    found = await search_posts(
                        tg,
                        query,
                        args["resultsPerQuery"],
                        limiter,
                        args["minDate"],
                        args["maxDate"],
                    )
                else:
                    found = await search_global(
                        tg,
                        query,
                        args["resultsPerQuery"],
                        limiter,
                        args["minDate"],
                        args["maxDate"],
                    )
                for channel, post in found:
                    count = channel.get("participantsCount")
                    if count is not None and count < args["minParticipants"]:
                        continue
                    add_result(results, operation, query, channel, post)
                    if len(results) >= args["maxItems"]:
                        break
                if len(results) >= args["maxItems"]:
                    break
        if len(results) >= args["maxItems"]:
            warnings.append(f"Достигнут общий hard cap: {args['maxItems']}.")
        return {
            "ok": True,
            "requestCount": limiter.calls,
            "resultCount": len(results),
            "operations": args["operations"],
            "results": list(results.values()),
            "warnings": warnings,
            "billing": {
                "perResultUsd": 0,
                "paidStarsAllowed": False,
                "note": "MTProto не тарифицируется за результат; Telegram может применить FloodWait, Premium или Stars-лимит.",
            },
        }
    except errors.FloodWaitError as exc:
        raise WorkerError(
            f"Telegram остановил частые запросы. Повторите не раньше чем через {exc.seconds} сек.",
            "flood_wait",
            retryAfterSeconds=exc.seconds,
            completedRequests=limiter.calls,
        ) from exc
    except errors.PremiumAccountRequiredError as exc:
        raise WorkerError(
            "Эта поисковая операция требует Telegram Premium для текущего аккаунта.",
            "premium_required",
            completedRequests=limiter.calls,
        ) from exc
    except errors.RPCError as exc:
        message = getattr(exc, "message", None) or exc.__class__.__name__
        raise WorkerError(
            f"Telegram RPC: {message}",
            "rpc_error",
            rpcError=exc.__class__.__name__,
            completedRequests=limiter.calls,
        ) from exc
    finally:
        await tg.disconnect()
        protect_session()


async def command_sample(payload: Any) -> dict[str, Any]:
    args = validate_sample_input(payload)
    tg = client()
    limiter = RateLimiter(args["delaySeconds"])
    samples: list[dict[str, Any]] = []
    warnings: list[str] = []
    try:
        await ensure_authorized(tg)
        for username in args["channels"]:
            try:
                entity = await limiter.call(
                    lambda username=username: tg.get_input_entity(username)
                )
                messages = await limiter.call(
                    lambda entity=entity: tg.get_messages(
                        entity, limit=args["messagesPerChannel"]
                    )
                )
                posts = []
                for message in messages:
                    text = str(getattr(message, "message", "") or "").strip()
                    if not text:
                        continue
                    date = getattr(message, "date", None)
                    posts.append(
                        {
                            "id": str(message.id),
                            "text": text[:6000],
                            "date": date.astimezone(timezone.utc).isoformat()
                            if date
                            else None,
                            "url": f"https://t.me/{username}/{int(message.id)}",
                        }
                    )
                samples.append(
                    {
                        "username": username,
                        "url": f"https://t.me/{username}",
                        "posts": posts,
                    }
                )
            except (ValueError, errors.UsernameInvalidError, errors.UsernameNotOccupiedError) as exc:
                warnings.append(f"@{username}: публичный канал не найден ({exc}).")
        return {
            "ok": True,
            "requestCount": limiter.calls,
            "samples": samples,
            "warnings": warnings,
            "billing": {
                "perResultUsd": 0,
                "paidStarsAllowed": False,
                "note": "Чтение последних публичных постов через MTProto не тарифицируется за результат.",
            },
        }
    except errors.FloodWaitError as exc:
        raise WorkerError(
            f"Telegram остановил частые запросы. Повторите не раньше чем через {exc.seconds} сек.",
            "flood_wait",
            retryAfterSeconds=exc.seconds,
            completedRequests=limiter.calls,
        ) from exc
    except errors.RPCError as exc:
        message = getattr(exc, "message", None) or exc.__class__.__name__
        raise WorkerError(
            f"Telegram RPC: {message}",
            "rpc_error",
            rpcError=exc.__class__.__name__,
            completedRequests=limiter.calls,
        ) from exc
    finally:
        await tg.disconnect()
        protect_session()


def read_payload() -> Any:
    raw = sys.stdin.buffer.read(1024 * 1024 + 1)
    if len(raw) > 1024 * 1024:
        raise WorkerError("JSON input превышает 1 МБ.", "invalid_input")
    try:
        return json.loads(raw or b"{}")
    except json.JSONDecodeError as exc:
        raise WorkerError("Невалидный JSON input.", "invalid_input") from exc


async def run(command: str) -> dict[str, Any]:
    if command == "status":
        return await command_status()
    if command == "authorize":
        return await command_authorize()
    if command == "sample":
        return await command_sample(read_payload())
    return await command_search(read_payload())


def main() -> None:
    parser = argparse.ArgumentParser(description="Activity Checker Telegram MTProto worker")
    parser.add_argument("command", choices=("status", "authorize", "search", "sample"))
    args = parser.parse_args()
    try:
        output = asyncio.run(run(args.command))
        print(json.dumps(output, ensure_ascii=False))
    except WorkerError as exc:
        print(
            json.dumps(
                {"ok": False, "error": str(exc), "code": exc.code, **exc.details},
                ensure_ascii=False,
            )
        )
        raise SystemExit(2)
    except KeyboardInterrupt:
        print(
            json.dumps(
                {"ok": False, "error": "Операция отменена.", "code": "cancelled"},
                ensure_ascii=False,
            )
        )
        raise SystemExit(130)


if __name__ == "__main__":
    main()
