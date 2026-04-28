#!/usr/bin/env python3
"""Send a chat transcript to a Telegram username via Roman's user account.

Reads JSON {"username": "@foo", "text": "..."} from stdin.
Prints JSON {"ok": true} on success, {"ok": false, "error": "..."} otherwise.

Runs synchronously and exits — invoked once per pickup request from server.
"""
import asyncio
import json
import sys
from telethon import TelegramClient
from telethon.errors import (
    UsernameNotOccupiedError, UsernameInvalidError,
    PeerFloodError, UserPrivacyRestrictedError, FloodWaitError,
)

API_ID = 31506655
API_HASH = "e8390ff17f6a5c3e10f08093df438bd5"
SESSION = "/root/.telegram_session"


async def main():
    raw = sys.stdin.read()
    payload = json.loads(raw)
    username = (payload.get("username") or "").lstrip("@")
    text = payload.get("text") or ""
    if not username or not text:
        print(json.dumps({"ok": False, "error": "username and text required"}))
        return

    client = TelegramClient(SESSION, API_ID, API_HASH)
    await client.connect()
    try:
        if not await client.is_user_authorized():
            print(json.dumps({"ok": False, "error": "session not authorized"}))
            return
        try:
            entity = await client.get_entity(username)
        except (UsernameNotOccupiedError, UsernameInvalidError, ValueError):
            print(json.dumps({"ok": False, "error": f"user @{username} not found"}))
            return

        # Telegram message body limit ~4096 — chunk if needed
        chunks = []
        buf = ""
        for line in text.splitlines(keepends=True):
            if len(buf) + len(line) > 3800:
                chunks.append(buf)
                buf = ""
            buf += line
        if buf:
            chunks.append(buf)

        for c in chunks:
            try:
                await client.send_message(entity, c)
            except UserPrivacyRestrictedError:
                print(json.dumps({"ok": False, "error": "user privacy settings block messages from non-contacts"}))
                return
            except PeerFloodError:
                print(json.dumps({"ok": False, "error": "telegram rate-limit (peer flood)"}))
                return
            except FloodWaitError as e:
                print(json.dumps({"ok": False, "error": f"telegram flood wait {e.seconds}s"}))
                return
        print(json.dumps({"ok": True, "chunks": len(chunks)}))
    finally:
        await client.disconnect()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}))
