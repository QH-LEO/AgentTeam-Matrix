#!/usr/bin/env python3

import argparse
import base64
import json
import os
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path


CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
DEVICE_AUTH_USERCODE_URL = "https://auth.openai.com/api/accounts/deviceauth/usercode"
DEVICE_AUTH_TOKEN_URL = "https://auth.openai.com/api/accounts/deviceauth/token"
OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token"
DEVICE_VERIFICATION_URL = "https://auth.openai.com/codex/device"
USER_AGENT = "cc-switch-codex-oauth-tool"

HOME = Path.home()
SKILL_ROOT = Path(__file__).resolve().parents[1]
STATE_DIR = SKILL_ROOT / "state"
CC_SWITCH_DIR = HOME / ".cc-switch"
CLAUDE_DIR = HOME / ".claude"
FLOW_PATH = STATE_DIR / "codex_oauth_flow.json"
AUTH_PATH = CC_SWITCH_DIR / "codex_oauth_auth.json"
DB_PATH = CC_SWITCH_DIR / "cc-switch.db"
SETTINGS_PATH = CC_SWITCH_DIR / "settings.json"
CLAUDE_SETTINGS_PATH = CLAUDE_DIR / "settings.json"
LOG_PATH = CC_SWITCH_DIR / "logs" / "cc-switch.log"
BACKUP_ROOT = STATE_DIR / "backups"


class ToolError(RuntimeError):
    pass


def ensure_file(path: Path, label: str) -> None:
    if not path.exists():
        raise ToolError(f"{label} not found: {path}")


def load_json(path: Path, default=None):
    if not path.exists():
        return {} if default is None else default
    with path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def write_json_atomic(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2, ensure_ascii=True)
        fh.write("\n")
    tmp.replace(path)


def http_post_json(url: str, payload: dict) -> dict:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
        },
    )
    return read_json_response(req)


def http_post_form(url: str, payload: dict) -> dict:
    body = urllib.parse.urlencode(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": USER_AGENT,
        },
    )
    return read_json_response(req)


def read_json_response(req: urllib.request.Request) -> dict:
    try:
        with urllib.request.urlopen(req) as resp:
            data = resp.read().decode("utf-8")
            return json.loads(data)
    except urllib.error.HTTPError as exc:
        payload = exc.read().decode("utf-8", errors="replace")
        raise ToolError(f"HTTP {exc.code} for {req.full_url}: {payload}") from exc
    except urllib.error.URLError as exc:
        raise ToolError(f"Network error for {req.full_url}: {exc}") from exc


def decode_jwt_claims(token: str) -> dict:
    parts = token.split(".")
    if len(parts) != 3:
        raise ToolError("Invalid JWT format")
    payload = parts[1]
    payload += "=" * ((4 - len(payload) % 4) % 4)
    decoded = base64.urlsafe_b64decode(payload.encode("ascii"))
    return json.loads(decoded.decode("utf-8"))


def extract_identity(tokens: dict) -> tuple[str, str]:
    id_token = tokens.get("id_token")
    if not id_token:
        raise ToolError("Token response missing id_token")
    claims = decode_jwt_claims(id_token)
    auth_claims = claims.get("https://api.openai.com/auth") or {}
    account_id = auth_claims.get("chatgpt_account_id")
    email = claims.get("email") or ""
    if not account_id:
        raise ToolError("Unable to extract chatgpt_account_id from id_token")
    return account_id, email


def timestamp_ms() -> int:
    return int(time.time() * 1000)


def now_utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def backup_files(tag: str) -> Path:
    backup_dir = BACKUP_ROOT / f"{datetime.now().strftime('%Y%m%d-%H%M%S')}-{tag}"
    backup_dir.mkdir(parents=True, exist_ok=True)
    for source in (DB_PATH, SETTINGS_PATH, CLAUDE_SETTINGS_PATH):
        if source.exists():
            target = backup_dir / f"{source.name}.bak"
            target.write_bytes(source.read_bytes())
    return backup_dir


def open_browser(url: str) -> None:
    subprocess.run(["open", url], check=False)


def restart_cc_switch(wait_seconds: int = 6) -> None:
    subprocess.run(["osascript", "-e", 'quit app "CC Switch"'], check=False)
    time.sleep(2)
    subprocess.run(["open", "-a", "CC Switch"], check=True)
    time.sleep(wait_seconds)


def default_haiku_model(model: str) -> str:
    mapping = {
        "gpt-5.4": "gpt-5.4-mini",
        "gpt-5": "gpt-5-codex-mini-high",
    }
    return mapping.get(model, model)


def build_provider_settings(model: str, haiku_model: str | None) -> dict:
    return {
        "env": {
            "ANTHROPIC_BASE_URL": "https://chatgpt.com/backend-api/codex",
            "ANTHROPIC_MODEL": model,
            "ANTHROPIC_DEFAULT_HAIKU_MODEL": haiku_model or default_haiku_model(model),
            "ANTHROPIC_DEFAULT_SONNET_MODEL": model,
            "ANTHROPIC_DEFAULT_OPUS_MODEL": model,
        },
        "includeCoAuthoredBy": False,
    }


def build_provider_meta(account_id: str) -> dict:
    return {
        "commonConfigEnabled": True,
        "endpointAutoSelect": True,
        "apiFormat": "openai_responses",
        "providerType": "codex_oauth",
        "authBinding": {
            "source": "managed_account",
            "authProvider": "codex_oauth",
            "accountId": account_id,
        },
    }


def get_or_create_provider_id(conn: sqlite3.Connection) -> str:
    row = conn.execute(
        """
        SELECT id
        FROM providers
        WHERE app_type = 'claude' AND provider_type = 'codex_oauth'
        ORDER BY is_current DESC, created_at ASC
        LIMIT 1
        """
    ).fetchone()
    return row[0] if row else str(uuid.uuid4())


def save_auth_store(account_id: str, email: str, refresh_token: str) -> None:
    store = {
        "version": 1,
        "accounts": {
            account_id: {
                "account_id": account_id,
                "email": email,
                "refresh_token": refresh_token,
                "authenticated_at": int(time.time()),
            }
        },
        "default_account_id": account_id,
    }
    write_json_atomic(AUTH_PATH, store)


def update_provider(model: str, haiku_model: str | None, account_id: str, provider_name: str) -> dict:
    ensure_file(DB_PATH, "cc-switch database")
    conn = sqlite3.connect(DB_PATH)
    try:
        provider_id = get_or_create_provider_id(conn)
        settings_config = json.dumps(
            build_provider_settings(model, haiku_model),
            separators=(",", ":"),
            ensure_ascii=True,
        )
        meta = json.dumps(
            build_provider_meta(account_id),
            separators=(",", ":"),
            ensure_ascii=True,
        )
        conn.execute("BEGIN")
        conn.execute("UPDATE providers SET is_current = 0 WHERE app_type = 'claude'")
        conn.execute(
            """
            INSERT INTO providers (
                id, app_type, name, settings_config, website_url, category,
                created_at, sort_index, notes, icon, icon_color, meta,
                is_current, in_failover_queue, cost_multiplier, provider_type
            )
            VALUES (?, 'claude', ?, ?, ?, 'third_party', ?, 1, NULL, 'openai', '#000000', ?, 1, 0, '1.0', 'codex_oauth')
            ON CONFLICT(id, app_type) DO UPDATE SET
                name = excluded.name,
                settings_config = excluded.settings_config,
                website_url = excluded.website_url,
                category = excluded.category,
                created_at = excluded.created_at,
                sort_index = excluded.sort_index,
                icon = excluded.icon,
                icon_color = excluded.icon_color,
                meta = excluded.meta,
                is_current = 1,
                in_failover_queue = 0,
                cost_multiplier = '1.0',
                provider_type = 'codex_oauth'
            """,
            (
                provider_id,
                provider_name,
                settings_config,
                "https://openai.com/chatgpt/pricing",
                timestamp_ms(),
                meta,
            ),
        )
        conn.execute("UPDATE proxy_config SET enabled = 1 WHERE app_type = 'claude'")
        conn.commit()
        return {"provider_id": provider_id, "model": model}
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def update_local_settings(provider_id: str) -> None:
    settings = load_json(SETTINGS_PATH, default={})
    settings["currentProviderClaude"] = provider_id
    settings["enableLocalProxy"] = True
    write_json_atomic(SETTINGS_PATH, settings)


def cmd_start_login(args: argparse.Namespace) -> int:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    response = http_post_json(
        DEVICE_AUTH_USERCODE_URL,
        {"client_id": CODEX_CLIENT_ID},
    )
    expires_in = int(response.get("expires_in", 900))
    flow = {
        "device_auth_id": response["device_auth_id"],
        "user_code": response["user_code"],
        "interval": response.get("interval", 5),
        "expires_at": (
            datetime.now(timezone.utc) + timedelta(seconds=expires_in)
        ).isoformat(),
    }
    write_json_atomic(FLOW_PATH, flow)
    if not args.no_open:
        open_browser(DEVICE_VERIFICATION_URL)
    print(json.dumps({
        "user_code": flow["user_code"],
        "device_auth_id": flow["device_auth_id"],
        "verification_uri": DEVICE_VERIFICATION_URL,
        "expires_in": expires_in,
        "flow_path": str(FLOW_PATH),
    }, indent=2, ensure_ascii=True))
    return 0


def read_flow() -> dict:
    ensure_file(FLOW_PATH, "device flow file")
    return load_json(FLOW_PATH)


def exchange_authorized_device(flow: dict) -> dict:
    poll_response = http_post_json(
        DEVICE_AUTH_TOKEN_URL,
        {
            "device_auth_id": flow["device_auth_id"],
            "user_code": flow["user_code"],
        },
    )
    if "authorization_code" not in poll_response:
        raise ToolError(f"Device flow not authorized yet: {json.dumps(poll_response, ensure_ascii=True)}")
    tokens = http_post_form(
        OAUTH_TOKEN_URL,
        {
            "grant_type": "authorization_code",
            "code": poll_response["authorization_code"],
            "redirect_uri": "https://auth.openai.com/deviceauth/callback",
            "client_id": CODEX_CLIENT_ID,
            "code_verifier": poll_response["code_verifier"],
        },
    )
    return tokens


def cmd_complete_login(args: argparse.Namespace) -> int:
    ensure_file(SETTINGS_PATH, "cc-switch settings")
    ensure_file(CLAUDE_SETTINGS_PATH, "Claude settings")
    flow = read_flow()
    tokens = exchange_authorized_device(flow)
    refresh_token = tokens.get("refresh_token")
    if not refresh_token:
        raise ToolError("Token response missing refresh_token")
    account_id, email = extract_identity(tokens)
    backup_dir = backup_files("codex-oauth")
    save_auth_store(account_id, email, refresh_token)
    result = update_provider(args.model, args.haiku_model, account_id, args.provider_name)
    update_local_settings(result["provider_id"])
    if args.restart_cc_switch:
        restart_cc_switch()
    print(json.dumps({
        "account_id": account_id,
        "email": email,
        "provider_id": result["provider_id"],
        "model": args.model,
        "backup_dir": str(backup_dir),
        "restarted_cc_switch": bool(args.restart_cc_switch),
    }, indent=2, ensure_ascii=True))
    return 0


def current_codex_provider(conn: sqlite3.Connection) -> tuple[str, dict] | tuple[None, None]:
    row = conn.execute(
        """
        SELECT id, settings_config
        FROM providers
        WHERE app_type = 'claude' AND provider_type = 'codex_oauth'
        ORDER BY is_current DESC, created_at ASC
        LIMIT 1
        """
    ).fetchone()
    if not row:
        return None, None
    return row[0], json.loads(row[1])


def cmd_set_model(args: argparse.Namespace) -> int:
    ensure_file(DB_PATH, "cc-switch database")
    backup_dir = backup_files("model-switch")
    conn = sqlite3.connect(DB_PATH)
    try:
        provider_id, settings = current_codex_provider(conn)
        if not provider_id:
            raise ToolError("No Claude codex_oauth provider found")
        env = settings.setdefault("env", {})
        env["ANTHROPIC_MODEL"] = args.model
        env["ANTHROPIC_DEFAULT_HAIKU_MODEL"] = args.haiku_model or default_haiku_model(args.model)
        env["ANTHROPIC_DEFAULT_SONNET_MODEL"] = args.model
        env["ANTHROPIC_DEFAULT_OPUS_MODEL"] = args.model
        env.pop("ANTHROPIC_AUTH_TOKEN", None)
        conn.execute(
            "UPDATE providers SET settings_config = ? WHERE id = ? AND app_type = 'claude'",
            (json.dumps(settings, separators=(",", ":"), ensure_ascii=True), provider_id),
        )
        conn.commit()
    finally:
        conn.close()
    if args.restart_cc_switch:
        restart_cc_switch()
    print(json.dumps({
        "provider_id": provider_id,
        "model": args.model,
        "haiku_model": args.haiku_model or default_haiku_model(args.model),
        "backup_dir": str(backup_dir),
        "restarted_cc_switch": bool(args.restart_cc_switch),
    }, indent=2, ensure_ascii=True))
    return 0


def cmd_status(_args: argparse.Namespace) -> int:
    ensure_file(DB_PATH, "cc-switch database")
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        provider = conn.execute(
            """
            SELECT id, name, provider_type, is_current, settings_config
            FROM providers
            WHERE app_type = 'claude'
            ORDER BY is_current DESC, created_at ASC
            LIMIT 1
            """
        ).fetchone()
        proxy = conn.execute(
            """
            SELECT app_type, enabled, proxy_enabled, live_takeover_active, listen_address, listen_port
            FROM proxy_config
            WHERE app_type = 'claude'
            """
        ).fetchone()
    finally:
        conn.close()
    provider_settings = json.loads(provider["settings_config"]) if provider else {}
    claude_live = load_json(CLAUDE_SETTINGS_PATH, default={})
    auth_store = load_json(AUTH_PATH, default={})
    result = {
        "provider": {
            "id": provider["id"] if provider else None,
            "name": provider["name"] if provider else None,
            "provider_type": provider["provider_type"] if provider else None,
            "is_current": bool(provider["is_current"]) if provider else False,
            "model": provider_settings.get("env", {}).get("ANTHROPIC_MODEL"),
            "haiku_model": provider_settings.get("env", {}).get("ANTHROPIC_DEFAULT_HAIKU_MODEL"),
        },
        "proxy": dict(proxy) if proxy else None,
        "claude_live": {
            "base_url": claude_live.get("env", {}).get("ANTHROPIC_BASE_URL"),
            "auth_token": claude_live.get("env", {}).get("ANTHROPIC_AUTH_TOKEN"),
        },
        "auth_store": {
            "default_account_id": auth_store.get("default_account_id"),
            "account_count": len(auth_store.get("accounts", {})),
        },
    }
    print(json.dumps(result, indent=2, ensure_ascii=True))
    return 0


def cmd_verify_logs(args: argparse.Namespace) -> int:
    ensure_file(LOG_PATH, "cc-switch log")
    lines = LOG_PATH.read_text(encoding="utf-8", errors="replace").splitlines()
    tail = lines[-args.lines :]
    matches = [
        line
        for line in tail
        if "backend-api/codex/responses" in line
        or "model=gpt-" in line
        or "CodexOAuth" in line
    ]
    if not matches:
        print("No matching Codex OAuth log lines found in recent log window.")
        return 1
    for line in matches:
        print(line)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Manage CC Switch Codex OAuth routing for Claude Code on macOS."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    start = subparsers.add_parser("start-login", help="Request a new ChatGPT device code.")
    start.add_argument("--no-open", action="store_true", help="Do not open the browser automatically.")
    start.set_defaults(func=cmd_start_login)

    complete = subparsers.add_parser(
        "complete-login",
        help="Exchange an authorized device flow for tokens, update CC Switch, and optionally restart it.",
    )
    complete.add_argument("--model", default="gpt-5.4", help="Target model for Claude provider mapping.")
    complete.add_argument("--haiku-model", default=None, help="Override the Haiku model mapping.")
    complete.add_argument("--provider-name", default="Codex", help="Provider card name inside CC Switch.")
    complete.add_argument("--restart-cc-switch", action="store_true", help="Restart CC Switch after updating config.")
    complete.set_defaults(func=cmd_complete_login)

    set_model = subparsers.add_parser("set-model", help="Update model mapping for the current Claude codex_oauth provider.")
    set_model.add_argument("--model", required=True, help="Target model, for example gpt-5.4.")
    set_model.add_argument("--haiku-model", default=None, help="Override the Haiku model mapping.")
    set_model.add_argument("--restart-cc-switch", action="store_true", help="Restart CC Switch after updating config.")
    set_model.set_defaults(func=cmd_set_model)

    status = subparsers.add_parser("status", help="Show current Claude Codex OAuth routing status.")
    status.set_defaults(func=cmd_status)

    verify = subparsers.add_parser("verify-logs", help="Print recent Codex OAuth log lines.")
    verify.add_argument("--lines", type=int, default=120, help="How many trailing log lines to inspect.")
    verify.set_defaults(func=cmd_verify_logs)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        return args.func(args)
    except ToolError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
