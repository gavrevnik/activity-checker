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
from collections import Counter
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
from urllib.parse import urlparse
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from telethon import TelegramClient, errors, functions, types


DISCOVERY_OPERATIONS = (
    "searchPublicChats",
    "channels.getChannelRecommendations",
)
MONITORING_FILTERS = json.loads(
    (Path(__file__).resolve().parents[1] / "data/telegram-monitoring-filters.json").read_text(encoding="utf-8")
)


class WorkerError(Exception):
    def __init__(self, message: str, code: str = "telegram_error", **details: Any):
        super().__init__(message)
        self.code = code
        self.details = details


@dataclass
class RateLimiter:
    delay: float
    jitter: float = 0.75
    calls: int = 0

    async def call(self, callback: Callable[[], Awaitable[Any]]) -> Any:
        if self.calls:
            await asyncio.sleep(self.delay + random.uniform(0, self.jitter))
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
    if not operations or any(
        operation not in DISCOVERY_OPERATIONS for operation in operations
    ):
        raise WorkerError(
            "Discovery поддерживает только поиск каналов и рекомендации.",
            "invalid_input",
        )
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


def string_list(
    payload: dict[str, Any], key: str, maximum: int, item_maximum: int = 200
) -> list[str]:
    raw_values = payload.get(key, [])
    if not isinstance(raw_values, list):
        raise WorkerError(f"{key} должен быть array.", "invalid_input")
    values: list[str] = []
    for raw in raw_values:
        if not isinstance(raw, str):
            raise WorkerError(f"{key} должны быть строками.", "invalid_input")
        value = raw.strip()
        if value and value not in values:
            values.append(value)
    if len(values) > maximum or any(len(value) > item_maximum for value in values):
        raise WorkerError(f"Параметр {key} превышает лимит.", "invalid_input")
    return values


def message_id_map(payload: dict[str, Any], key: str) -> dict[str, int]:
    raw = payload.get(key, {})
    if not isinstance(raw, dict) or len(raw) > 20:
        raise WorkerError(f"{key} должен быть object до 20 каналов.", "invalid_input")
    output: dict[str, int] = {}
    for channel, value in raw.items():
        if not isinstance(channel, str) or not str(value).isdigit():
            raise WorkerError(f"Невалидный {key}.", "invalid_input")
        output[normalized_seed(channel).casefold()] = int(value)
    return output


def zoned_date_bound(
    value: Any, zone: ZoneInfo, end: bool = False
) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        if len(value) == 10:
            day = datetime.fromisoformat(value).date()
            parsed = datetime.combine(day, time.max if end else time.min, zone)
        else:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=zone)
        return parsed.astimezone(timezone.utc)
    except ValueError as exc:
        raise WorkerError(f"Некорректная дата: {value}", "invalid_input") from exc


def validate_monitor_input(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise WorkerError("Ожидается JSON object.", "invalid_input")
    payload = {"excludeKeywords": MONITORING_FILTERS["excludeKeywords"], **payload}
    channels = [normalized_seed(value) for value in string_list(payload, "channels", 20)]
    channels = list(dict.fromkeys(channel for channel in channels if channel))
    if not channels:
        raise WorkerError("Нужен хотя бы один публичный канал.", "invalid_input")
    zone_name = str(payload.get("timeZone", "Europe/Belgrade")).strip()
    try:
        zone = ZoneInfo(zone_name)
    except ZoneInfoNotFoundError as exc:
        raise WorkerError(f"Неизвестная timezone: {zone_name}", "invalid_input") from exc
    start_date = zoned_date_bound(payload.get("startDate"), zone)
    end_date = zoned_date_bound(payload.get("endDate"), zone, True)
    if start_date and end_date and start_date > end_date:
        raise WorkerError("startDate не может быть позже endDate.", "invalid_input")
    max_posts = int(payload.get("maxPostsPerChannel", 100))
    max_scanned = int(payload.get("maxScannedPerChannel", 500))
    page_size = int(payload.get("pageSize", 100))
    delay = float(payload.get("delaySeconds", 4))
    min_views = int(payload.get("minViews", 0))
    min_text_length = int(payload.get("minTextLength", 0))
    if not 1 <= max_posts <= 500:
        raise WorkerError("maxPostsPerChannel: допустимо 1..500.", "invalid_input")
    if not 1 <= max_scanned <= 5000 or max_scanned < max_posts:
        raise WorkerError(
            "maxScannedPerChannel: допустимо 1..5000 и не меньше maxPostsPerChannel.",
            "invalid_input",
        )
    if not 10 <= page_size <= 100:
        raise WorkerError("pageSize: допустимо 10..100.", "invalid_input")
    if not 3 <= delay <= 30:
        raise WorkerError("Пауза monitoring должна быть 3..30 секунд.", "invalid_input")
    if not 0 <= min_views <= 2_000_000_000:
        raise WorkerError("Невалидный minViews.", "invalid_input")
    if not 0 <= min_text_length <= 20_000:
        raise WorkerError("Невалидный minTextLength.", "invalid_input")
    return {
        "channels": channels,
        "startDate": start_date,
        "endDate": end_date,
        "timeZone": zone_name,
        "maxPostsPerChannel": max_posts,
        "maxScannedPerChannel": max_scanned,
        "pageSize": page_size,
        "afterMessageIds": message_id_map(payload, "afterMessageIds"),
        "beforeMessageIds": message_id_map(payload, "beforeMessageIds"),
        "minViews": min_views,
        "minTextLength": min_text_length,
        "excludeForwards": bool(payload.get("excludeForwards", False)),
        "excludeReplies": bool(payload.get("excludeReplies", True)),
        "excludeMediaOnly": bool(payload.get("excludeMediaOnly", False)),
        "excludeAdDisclosures": bool(payload.get("excludeAdDisclosures", True)),
        "excludeKeywords": [
            value.casefold() for value in string_list(payload, "excludeKeywords", 100)
        ],
        "excludeHashtags": [
            value.casefold().lstrip("#")
            for value in string_list(payload, "excludeHashtags", 100, 100)
        ],
        "excludeLinkDomains": [
            value.casefold().removeprefix("www.")
            for value in string_list(payload, "excludeLinkDomains", 100, 253)
        ],
        "excludeMediaTypes": [
            value.casefold()
            for value in string_list(payload, "excludeMediaTypes", 50, 100)
        ],
        "delaySeconds": delay,
    }


async def ensure_authorized(tg: TelegramClient) -> None:
    await tg.connect()
    if not await tg.is_user_authorized():
        raise WorkerError(
            "Telegram-сессия не авторизована. Выполните npm run telegram:auth.",
            "authorization_required",
        )


def iso_datetime(value: Any) -> str | None:
    return (
        value.astimezone(timezone.utc).isoformat()
        if isinstance(value, datetime)
        else None
    )


def object_id(value: Any) -> str | None:
    if value is None:
        return None
    raw = getattr(value, "channel_id", None)
    if raw is None:
        raw = getattr(value, "chat_id", None)
    if raw is None:
        raw = getattr(value, "user_id", None)
    if raw is None and isinstance(value, int):
        raw = value
    return str(raw) if raw is not None else None


def unique_strings(values: list[str]) -> list[str]:
    return list(dict.fromkeys(value for value in values if value))


def message_entities(message: Any) -> list[dict[str, Any]]:
    pairs: list[tuple[Any, str]] = []
    try:
        pairs = list(message.get_entities_text() or [])
    except (AttributeError, TypeError, ValueError):
        pass
    output: list[dict[str, Any]] = []
    for entity, text in pairs:
        item: dict[str, Any] = {
            "type": type(entity).__name__.removeprefix("MessageEntity"),
            "text": str(text or ""),
            "offset": int(getattr(entity, "offset", 0) or 0),
            "length": int(getattr(entity, "length", 0) or 0),
        }
        for source, target in (
            ("url", "url"),
            ("user_id", "userId"),
            ("language", "language"),
            ("document_id", "documentId"),
        ):
            value = getattr(entity, source, None)
            if value is not None:
                item[target] = str(value)
        output.append(item)
    return output


def reaction_label(value: Any) -> str:
    emoji = getattr(value, "emoticon", None)
    if emoji:
        return str(emoji)
    document_id = getattr(value, "document_id", None)
    if document_id is not None:
        return f"custom:{document_id}"
    return type(value).__name__.removeprefix("Reaction").casefold() or "unknown"


def message_reactions(message: Any) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    for item in getattr(getattr(message, "reactions", None), "results", None) or []:
        output.append(
            {
                "reaction": reaction_label(getattr(item, "reaction", None)),
                "count": int(getattr(item, "count", 0) or 0),
                "chosen": getattr(item, "chosen_order", None) is not None,
            }
        )
    return output


def document_media(document: Any) -> dict[str, Any]:
    output: dict[str, Any] = {
        "type": "document",
        "mimeType": getattr(document, "mime_type", None),
        "sizeBytes": getattr(document, "size", None),
    }
    for attribute in getattr(document, "attributes", None) or []:
        if isinstance(attribute, types.DocumentAttributeFilename):
            output["fileName"] = attribute.file_name
        elif isinstance(attribute, types.DocumentAttributeAnimated):
            output["type"] = "animation"
        elif isinstance(attribute, types.DocumentAttributeSticker):
            output["type"] = "sticker"
            output["stickerAlt"] = attribute.alt
        elif isinstance(attribute, types.DocumentAttributeVideo):
            output["type"] = "round_video" if attribute.round_message else "video"
            output["durationSeconds"] = float(attribute.duration)
            output["width"] = int(attribute.w)
            output["height"] = int(attribute.h)
        elif isinstance(attribute, types.DocumentAttributeAudio):
            output["type"] = "voice" if attribute.voice else "audio"
            output["durationSeconds"] = float(attribute.duration)
            output["title"] = attribute.title
            output["performer"] = attribute.performer
    return {key: value for key, value in output.items() if value is not None}


def message_media(message: Any) -> dict[str, Any] | None:
    media = getattr(message, "media", None)
    if media is None:
        return None
    if isinstance(media, types.MessageMediaPhoto):
        photo = getattr(media, "photo", None)
        sizes = getattr(photo, "sizes", None) or []
        width = max((int(getattr(size, "w", 0) or 0) for size in sizes), default=0)
        height = max((int(getattr(size, "h", 0) or 0) for size in sizes), default=0)
        return {"type": "photo", "width": width, "height": height}
    if isinstance(media, types.MessageMediaDocument):
        return document_media(getattr(media, "document", None))
    if isinstance(media, types.MessageMediaWebPage):
        webpage = getattr(media, "webpage", None)
        return {
            key: value
            for key, value in {
                "type": "webpage",
                "url": getattr(webpage, "url", None),
                "displayUrl": getattr(webpage, "display_url", None),
                "siteName": getattr(webpage, "site_name", None),
                "title": getattr(webpage, "title", None),
                "description": getattr(webpage, "description", None),
            }.items()
            if value is not None
        }
    if isinstance(media, types.MessageMediaPoll):
        poll = getattr(media, "poll", None)
        question = getattr(poll, "question", None)
        answers = []
        for answer in getattr(poll, "answers", None) or []:
            answer_text = getattr(answer, "text", "")
            answers.append(str(getattr(answer_text, "text", answer_text) or ""))
        return {
            "type": "poll",
            "question": str(getattr(question, "text", question) or ""),
            "answers": answers,
            "closed": bool(getattr(poll, "closed", False)),
            "quiz": bool(getattr(poll, "quiz", False)),
            "totalVoters": int(
                getattr(getattr(media, "results", None), "total_voters", 0) or 0
            ),
        }
    if isinstance(media, types.MessageMediaVenue):
        geo = getattr(media, "geo", None)
        return {
            "type": "venue",
            "title": str(getattr(media, "title", "") or ""),
            "address": str(getattr(media, "address", "") or ""),
            "latitude": getattr(geo, "lat", None),
            "longitude": getattr(geo, "long", None),
        }
    if isinstance(media, (types.MessageMediaGeo, types.MessageMediaGeoLive)):
        geo = getattr(media, "geo", None)
        return {
            "type": "live_geo" if isinstance(media, types.MessageMediaGeoLive) else "geo",
            "latitude": getattr(geo, "lat", None),
            "longitude": getattr(geo, "long", None),
        }
    if isinstance(media, types.MessageMediaContact):
        return {
            "type": "contact",
            "firstName": str(getattr(media, "first_name", "") or ""),
            "lastName": str(getattr(media, "last_name", "") or ""),
        }
    if isinstance(media, types.MessageMediaDice):
        return {
            "type": "dice",
            "emoticon": str(getattr(media, "emoticon", "") or ""),
            "value": int(getattr(media, "value", 0) or 0),
        }
    return {"type": type(media).__name__.removeprefix("MessageMedia").casefold()}


def message_buttons(message: Any) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    try:
        rows = message.buttons or []
    except (AttributeError, TypeError):
        rows = []
    for row in rows:
        for button in row:
            output.append(
                {
                    "text": str(getattr(button, "text", "") or ""),
                    "url": getattr(button, "url", None),
                }
            )
    return output[:100]


def forward_payload(message: Any) -> dict[str, Any] | None:
    forward = getattr(message, "fwd_from", None)
    if forward is None:
        return None
    return {
        key: value
        for key, value in {
            "fromId": object_id(getattr(forward, "from_id", None)),
            "fromName": getattr(forward, "from_name", None),
            "date": iso_datetime(getattr(forward, "date", None)),
            "channelPostId": str(getattr(forward, "channel_post", "") or "") or None,
            "postAuthor": getattr(forward, "post_author", None),
            "savedFromPeerId": object_id(getattr(forward, "saved_from_peer", None)),
            "savedFromMessageId": str(
                getattr(forward, "saved_from_msg_id", "") or ""
            )
            or None,
        }.items()
        if value is not None
    }


def monitoring_post(message: Any, username: str) -> dict[str, Any]:
    text = str(getattr(message, "message", "") or "")[:20000]
    entities = message_entities(message)
    buttons = message_buttons(message)
    media = message_media(message)
    hashtags = unique_strings(
        [item["text"].lstrip("#") for item in entities if item["type"] == "Hashtag"]
        + re.findall(r"(?<!\w)#([\w\d_]+)", text, flags=re.UNICODE)
    )
    mentions = unique_strings(
        [item["text"].lstrip("@") for item in entities if item["type"] == "Mention"]
        + re.findall(r"(?<!\w)@([A-Za-z0-9_]{5,})", text)
    )
    links = [
        item.get("url") or item["text"]
        for item in entities
        if item["type"] in ("Url", "TextUrl")
    ]
    links.extend(
        str(button["url"]) for button in buttons if button.get("url")
    )
    if media and media.get("type") == "webpage" and media.get("url"):
        links.append(str(media["url"]))
    links.extend(re.findall(r"https?://[^\s<>()]+", text))
    links = unique_strings([str(link).rstrip(".,;:!?") for link in links])
    reactions = message_reactions(message)
    text_folded = text.casefold()
    domains = [urlparse(link).hostname or "" for link in links]
    ad_disclosures = (
        "на правах рекламы",
        "рекламная интеграция",
        "рекламный пост",
        "paid partnership",
    )
    # A ticket price or an event discount is not enough to identify advertising.
    ad_hashtags = {"реклама", "рекламныйпост", "ad", "advertisement", "sponsored"}
    has_ad_disclosure = (
        bool({tag.casefold() for tag in hashtags} & ad_hashtags)
        or any(term in text_folded for term in ad_disclosures)
        or bool(re.search(r"\berid\s*[:=]\s*[a-z0-9]+", text_folded))
        or any(re.search(r"[?&]erid=[a-z0-9]+", link, re.IGNORECASE) for link in links)
    )
    promo_terms = (
        "промокод",
        "promo code",
        "купон",
        "скидк",
        "discount",
    )
    restrictions = []
    for reason in getattr(message, "restriction_reason", None) or []:
        restrictions.append(
            {
                "platform": str(getattr(reason, "platform", "") or ""),
                "reason": str(getattr(reason, "reason", "") or ""),
                "text": str(getattr(reason, "text", "") or ""),
            }
        )
    reply = getattr(message, "reply_to", None)
    return {
        "id": str(message.id),
        "text": text,
        "date": iso_datetime(getattr(message, "date", None)),
        "editDate": iso_datetime(getattr(message, "edit_date", None)),
        "url": f"https://t.me/{username}/{int(message.id)}",
        "authorSignature": getattr(message, "post_author", None),
        "senderId": object_id(getattr(message, "from_id", None)),
        "viaBotId": str(getattr(message, "via_bot_id", "") or "") or None,
        "groupedId": str(getattr(message, "grouped_id", "") or "") or None,
        "replyToMessageId": str(getattr(reply, "reply_to_msg_id", "") or "")
        or None,
        "replyToTopId": str(getattr(reply, "reply_to_top_id", "") or "") or None,
        "isPost": bool(getattr(message, "post", False)),
        "isForwarded": getattr(message, "fwd_from", None) is not None,
        "isReply": reply is not None,
        "isPinned": bool(getattr(message, "pinned", False)),
        "isSilent": bool(getattr(message, "silent", False)),
        "noForwards": bool(getattr(message, "noforwards", False)),
        "views": getattr(message, "views", None),
        "forwards": getattr(message, "forwards", None),
        "replyCount": getattr(getattr(message, "replies", None), "replies", None),
        "reactionCount": sum(item["count"] for item in reactions),
        "reactions": reactions,
        "media": media,
        "entities": entities,
        "hashtags": hashtags,
        "mentions": mentions,
        "links": links,
        "buttons": buttons,
        "forward": forward_payload(message),
        "restrictionReasons": restrictions,
        "signals": {
            "hasText": bool(text.strip()),
            "hasMedia": media is not None,
            "hasExternalLink": any(
                domain and not domain.casefold().removeprefix("www.").endswith("t.me")
                for domain in domains
            ),
            "hasTelegramLink": any(
                domain.casefold().removeprefix("www.").endswith("t.me")
                for domain in domains
            ),
            "hasPrice": bool(
                re.search(
                    r"(?:\b\d[\d .,'\u00a0]{0,12}\s?(?:rsd|din(?:ara?)?|eur|usd)\b|[\u20ac$]\s?\d)",
                    text,
                    flags=re.IGNORECASE,
                )
            ),
            "hasPromoLanguage": any(term in text_folded for term in promo_terms),
            "hasAdDisclosure": has_ad_disclosure,
        },
    }


def excluded_reason(post: dict[str, Any], args: dict[str, Any]) -> str | None:
    text = post["text"].casefold()
    if args["minViews"] and (post["views"] or 0) < args["minViews"]:
        return "minViews"
    if len(post["text"].strip()) < args["minTextLength"]:
        return "minTextLength"
    if args["excludeForwards"] and post["isForwarded"]:
        return "forward"
    if args["excludeReplies"] and post["isReply"]:
        return "reply"
    if args["excludeMediaOnly"] and not post["signals"]["hasText"]:
        return "mediaOnly"
    if args["excludeAdDisclosures"] and post["signals"]["hasAdDisclosure"]:
        return "adDisclosure"
    if any(keyword in text for keyword in args["excludeKeywords"]):
        return "keyword"
    if set(value.casefold() for value in post["hashtags"]) & set(
        args["excludeHashtags"]
    ):
        return "hashtag"
    for link in post["links"]:
        domain = (urlparse(link).hostname or "").casefold().removeprefix("www.")
        if any(domain == blocked or domain.endswith("." + blocked) for blocked in args["excludeLinkDomains"]):
            return "linkDomain"
    media_type = (post["media"] or {}).get("type", "").casefold()
    if media_type and media_type in args["excludeMediaTypes"]:
        return "mediaType"
    return None


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


# Intentionally dormant: discovery no longer dispatches channels.searchPosts.
# Keep the implementation nearby so it can be reviewed and explicitly restored
# later without mixing paid/full-text semantics into channel discovery.
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


# Intentionally dormant alongside search_posts: monitoring reads the history of
# explicitly selected channels instead of doing a global message search.
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
                found = await search_public_chats(
                    tg, query, args["resultsPerQuery"], limiter
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


async def command_monitor(payload: Any) -> dict[str, Any]:
    args = validate_monitor_input(payload)
    tg = client()
    limiter = RateLimiter(args["delaySeconds"], jitter=1.5)
    channels: list[dict[str, Any]] = []
    warnings: list[str] = []
    try:
        await ensure_authorized(tg)
        for requested_username in args["channels"]:
            try:
                chat = await limiter.call(
                    lambda requested_username=requested_username: tg.get_entity(
                        requested_username
                    )
                )
                channel = channel_payload(chat)
                if channel is None:
                    warnings.append(
                        f"@{requested_username}: это не публичный channel/supergroup."
                    )
                    continue
                username = channel["username"]
                cursor_key = requested_username.casefold()
                canonical_key = username.casefold()
                after_id = args["afterMessageIds"].get(
                    canonical_key, args["afterMessageIds"].get(cursor_key, 0)
                )
                before_id = args["beforeMessageIds"].get(
                    canonical_key, args["beforeMessageIds"].get(cursor_key, 0)
                )
                posts: list[dict[str, Any]] = []
                filter_counts: Counter[str] = Counter()
                scanned = 0
                history_ended = False
                reached_start = False
                oldest_scanned_id: int | None = None
                first_page = True
                while (
                    len(posts) < args["maxPostsPerChannel"]
                    and scanned < args["maxScannedPerChannel"]
                ):
                    page_limit = min(
                        args["pageSize"], args["maxScannedPerChannel"] - scanned
                    )
                    messages = await limiter.call(
                        lambda chat=chat,
                        page_limit=page_limit,
                        before_id=before_id,
                        first_page=first_page: tg.get_messages(
                            chat,
                            limit=page_limit,
                            offset_id=before_id,
                            offset_date=args["endDate"] if first_page else None,
                            min_id=after_id,
                        )
                    )
                    first_page = False
                    # Service messages still advance the cursor. Dropping them
                    # before checking page length can prematurely end history.
                    page = list(messages)
                    if not page:
                        history_ended = True
                        break
                    for message in page:
                        stamp = getattr(message, "date", None)
                        if args["startDate"] and stamp and stamp < args["startDate"]:
                            reached_start = True
                            break
                        if after_id and int(message.id) <= after_id:
                            history_ended = True
                            break
                        scanned += 1
                        oldest_scanned_id = int(message.id)
                        if not isinstance(message, types.Message):
                            filter_counts["service"] += 1
                            continue
                        if args["endDate"] and stamp and stamp > args["endDate"]:
                            filter_counts["afterEndDate"] += 1
                            continue
                        post = monitoring_post(message, username)
                        reason = excluded_reason(post, args)
                        if reason:
                            filter_counts[reason] += 1
                        else:
                            posts.append(post)
                        if (
                            len(posts) >= args["maxPostsPerChannel"]
                            or scanned >= args["maxScannedPerChannel"]
                        ):
                            break
                    if reached_start or history_ended:
                        break
                    if len(posts) >= args["maxPostsPerChannel"] or scanned >= args["maxScannedPerChannel"]:
                        # Even a short RPC page may have unprocessed messages.
                        history_ended = oldest_scanned_id == int(page[-1].id) and len(page) < page_limit
                        break
                    if len(page) < page_limit:
                        history_ended = True
                        break
                    before_id = int(page[-1].id)
                truncated = not history_ended and not reached_start and bool(
                    oldest_scanned_id
                )
                channels.append(
                    {
                        "channel": channel,
                        "scannedCount": scanned,
                        "returnedCount": len(posts),
                        "filteredCount": sum(filter_counts.values()),
                        "filterBreakdown": dict(filter_counts),
                        "truncated": truncated,
                        "nextBeforeMessageId": str(oldest_scanned_id)
                        if truncated and oldest_scanned_id is not None
                        else None,
                        "posts": posts,
                    }
                )
            except (
                ValueError,
                errors.UsernameInvalidError,
                errors.UsernameNotOccupiedError,
                errors.ChannelPrivateError,
            ) as exc:
                warnings.append(f"@{requested_username}: канал недоступен ({exc}).")
        return {
            "ok": True,
            "requestCount": limiter.calls,
            "range": {
                "startDate": iso_datetime(args["startDate"]),
                "endDate": iso_datetime(args["endDate"]),
                "timeZone": args["timeZone"],
            },
            "channels": channels,
            "warnings": warnings,
            "billing": {
                "perResultUsd": 0,
                "paidStarsAllowed": False,
                "note": "История выбранных каналов читается через messages.getHistory; Stars не используются.",
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
    if command == "monitor":
        return await command_monitor(read_payload())
    if command == "research":
        from telegram_research import command_research
        return await command_research(read_payload(), sys.modules[__name__])
    return await command_search(read_payload())


def main() -> None:
    parser = argparse.ArgumentParser(description="Activity Checker Telegram MTProto worker")
    parser.add_argument(
        "command", choices=("status", "authorize", "search", "sample", "monitor", "research")
    )
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
