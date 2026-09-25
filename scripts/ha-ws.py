#!/usr/bin/env python3
"""Send WebSocket API commands to Home Assistant and print their results.

REST covers states and service calls; the registries, config entries, dashboards,
statistics and HACS are only on the WebSocket API. This does the auth handshake and
message ids once, so a session does not rewrite them for each call.

Usage:  ha-ws.py '<json>' ['<json>' ...]   one command per argument, "id" left out
        ha-ws.py -                         one command per line on stdin
        e.g. ha-ws.py '{"type": "hacs/repositories/list"}'
Prints each command's "result" as JSON on its own line; stops at the first failed
command, prints its error to stderr and exits 1.
Needs:  python3 with `websockets`, the HA long-lived token in ~/.config/khe/ha-token.
"""
import asyncio, json, os, sys, websockets
HA = "192.168.0.11:8123"
TOKEN = open(os.path.expanduser("~/.config/khe/ha-token")).read().strip()

async def main(commands):
    # Dashboard configs and statistics exceed the 1 MiB default frame limit.
    async with websockets.connect(f"ws://{HA}/api/websocket", max_size=2**24) as ws:
        await ws.recv(); await ws.send(json.dumps({"type": "auth", "access_token": TOKEN}))
        if json.loads(await ws.recv())["type"] != "auth_ok":
            sys.exit("auth failed: check ~/.config/khe/ha-token")
        for mid, msg in enumerate(commands, 1):
            await ws.send(json.dumps({**msg, "id": mid}))
            while True:
                r = json.loads(await ws.recv())
                if r.get("id") == mid and r.get("type") == "result": break
            if not r.get("success"):
                print(f"{msg.get('type')}: {json.dumps(r.get('error'))}", file=sys.stderr); sys.exit(1)
            print(json.dumps(r.get("result"), ensure_ascii=False))

if __name__ == "__main__":
    args = sys.argv[1:]
    if not args: sys.exit(__doc__)
    lines = [l for l in sys.stdin if l.strip()] if args == ["-"] else args
    asyncio.run(main([json.loads(l) for l in lines]))
