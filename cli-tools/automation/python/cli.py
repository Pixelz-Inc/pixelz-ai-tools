import os
import sys
import json
import re
import time
import threading
import mimetypes
import requests
from urllib.parse import quote, quote_plus
from urllib3.util.retry import Retry
from requests.adapters import HTTPAdapter
import argparse
from dotenv import load_dotenv

load_dotenv(os.environ.get('PIXELZ_DOTENV_PATH') or os.path.abspath(os.path.join(os.path.dirname(__file__), '../../../.env')))

# Overridable so tests can point at a local stub and assert the exact outgoing payload.
AUTH_URL = os.environ.get('PIXELZ_AUTOMATION_AUTH_URL', 'https://id.pixelz.com/realms/pixelz-automations/protocol/openid-connect/token')

def redact_secrets(text):
    """Replace known credential values and bearer tokens in text with <REDACTED>.

    Credentials are matched in raw AND percent-encoded form. Automation creds travel in a
    form-encoded POST body, so they appear percent-encoded wherever requests echoes that
    body or a redirected URL, and a literal match would silently miss them. The param-name
    pass is the backstop for any encoding these variants don't anticipate.
    """
    s = str(text)
    for key in ('PIXELZ_AUTOMATION_CLIENT_ID', 'PIXELZ_AUTOMATION_CLIENT_SECRET'):
        val = os.getenv(key)
        if not val:
            continue
        for variant in {val, quote(val, safe=''), quote_plus(val)}:
            s = s.replace(variant, '<REDACTED>')
    s = re.sub(r'(client_id|client_secret)=[^&\s\'"]*', r'\1=<REDACTED>', s, flags=re.IGNORECASE)
    s = re.sub(r'eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', '<REDACTED>', s)
    return s
BASE_URL = os.environ.get('PIXELZ_AUTOMATION_BASE_URL', 'https://automation-api.pixelz.com/v1')
# Overridable so tests can exercise the timeout path without waiting 90 s.
REQUEST_TIMEOUT = float(os.environ.get('PIXELZ_REQUEST_TIMEOUT_SECONDS') or 90)

def _is_read_timeout(e):
    """requests reports a timeout while reading the body as ConnectionError(ReadTimeoutError)."""
    import urllib3
    return bool(e.args) and isinstance(e.args[0], urllib3.exceptions.ReadTimeoutError)
MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024  # 2 GB

# raise_on_status=False: once retries run out, hand back the last response so raise_for_status()
# reports [HTTP_<status>] (as Node does) instead of an uncategorized RetryError.
# retry_after_max: the same 60 s ceiling as Node, so a huge Retry-After cannot park a call for hours.
_retry = Retry(total=3, backoff_factor=1, status_forcelist=[429, 502, 503, 504], respect_retry_after_header=True,
               raise_on_status=False, retry_after_max=60)
_session = requests.Session()
_session.mount('https://', HTTPAdapter(max_retries=_retry))
_session.mount('http://', HTTPAdapter(max_retries=_retry))

_log_file = os.getenv('PIXELZ_LOG_FILE')

def log(level, message, data=None):
    if not _log_file:
        return
    from datetime import datetime, timezone
    entry = f"[{datetime.now(timezone.utc).isoformat()}] [{level}] {message}"
    if data is not None:
        entry += f" {json.dumps(data, default=str)}"
    # Redacted here, not at call sites: error text can carry a credentialed request URL.
    with open(_log_file, 'a') as f:
        f.write(redact_secrets(entry) + '\n')

def validate_id(value, name):
    if not re.match(r'^[a-zA-Z0-9_\-]+$', value):
        raise ValueError(f"Invalid {name}: contains unexpected characters")

_token_cache = {'token': None, 'expires_at': 0}
_token_lock = threading.Lock()

def get_token():
    if _token_cache['token'] and time.time() < _token_cache['expires_at']:
        return _token_cache['token']
    with _token_lock:
        if _token_cache['token'] and time.time() < _token_cache['expires_at']:
            return _token_cache['token']
        cid = os.getenv('PIXELZ_AUTOMATION_CLIENT_ID')
        sec = os.getenv('PIXELZ_AUTOMATION_CLIENT_SECRET')
        if not cid or not sec:
            # stderr, not stdout: callers parse stdout as JSON, so a diagnostic there would
            # surface as a JSON parse error instead of an actionable auth message.
            print("[AUTH_ERROR] Missing Automation API credentials.", file=sys.stderr)
            print("Required: PIXELZ_AUTOMATION_CLIENT_ID and PIXELZ_AUTOMATION_CLIENT_SECRET in .env file.", file=sys.stderr)
            sys.exit(1)

        log('info', 'Requesting new OAuth token')
        r = _session.post(AUTH_URL, data={'grant_type': 'client_credentials', 'client_id': cid, 'client_secret': sec}, timeout=REQUEST_TIMEOUT)
        r.raise_for_status()
        data = r.json()
        _token_cache['token'] = data['access_token']
        _token_cache['expires_at'] = time.time() + (data.get('expires_in', 3600) - 60)
        return _token_cache['token']

def ensure_url_or_id(input_path, token):
    if not input_path:
        return None
    if input_path.startswith(('http://', 'https://')):
        return input_path
    if not os.path.exists(input_path):
        raise Exception(f"Local file not found: {input_path}")
    resolved = os.path.realpath(input_path)
    if not os.path.isfile(resolved):
        raise Exception(f"Not a regular file: {input_path}")
    file_size = os.path.getsize(resolved)
    if file_size > MAX_FILE_SIZE:
        raise Exception(f"File too large ({file_size / (1024**3):.2f} GB). Maximum allowed size is 2 GB.")
    headers = {'Authorization': f'Bearer {token}'}
    file_name = os.path.basename(resolved)
    log('info', 'Requesting upload URL', {'fileName': file_name})
    r = _session.post(f"{BASE_URL}/files/request-upload-url", json={'fileName': file_name}, headers=headers, timeout=REQUEST_TIMEOUT)
    r.raise_for_status()
    upload_url = r.json()['url']
    content_type = mimetypes.guess_type(resolved)[0] or 'application/octet-stream'
    log('info', 'Uploading file', {'fileName': file_name, 'size': file_size})
    with open(resolved, 'rb') as f:
        r_put = _session.put(upload_url, data=f, headers={'Content-Type': content_type}, timeout=REQUEST_TIMEOUT)
        r_put.raise_for_status()
    return upload_url

def main():
    parser = argparse.ArgumentParser(description='Pixelz Automation CLI')
    subparsers = parser.add_subparsers(dest='command')

    remove_bg = subparsers.add_parser('remove-bg')
    remove_bg.add_argument('input')
    remove_bg.add_argument('--color')
    remove_bg.add_argument('--transparent', choices=['true', 'false'])
    remove_bg.add_argument('--feather', type=float)
    remove_bg.add_argument('--trimap')
    remove_bg.add_argument('--callback')
    remove_bg.add_argument('--sync', action='store_true', help='Run synchronously and return result immediately (may time out on large images)')

    color_match = subparsers.add_parser('color-match')
    color_match.add_argument('input')
    color_match.add_argument('markers')
    color_match.add_argument('--callback')
    color_match.add_argument('--sync', action='store_true')

    create_mask = subparsers.add_parser('create-mask')
    create_mask.add_argument('input')
    create_mask.add_argument('--feather', type=float)
    create_mask.add_argument('--trimap')
    create_mask.add_argument('--callback')
    create_mask.add_argument('--sync', action='store_true')

    create_trimap = subparsers.add_parser('create-trimap')
    create_trimap.add_argument('input')
    create_trimap.add_argument('--callback')
    create_trimap.add_argument('--sync', action='store_true')

    model_crop = subparsers.add_parser('model-crop')
    model_crop.add_argument('input')
    model_crop.add_argument('--top')
    model_crop.add_argument('--bottom')
    model_crop.add_argument('--callback')
    model_crop.add_argument('--sync', action='store_true')

    status = subparsers.add_parser('status')
    status.add_argument('job_id')

    subparsers.add_parser('get-key')

    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        return

    def make_headers(sync=False):
        h = {'Authorization': f'Bearer {token}'}
        if not sync:
            h['Respond-Mode'] = 'async'
        return h

    try:
        # Inside the try: a failure here (network, bad credentials, non-2xx from Keycloak)
        # must reach the handlers below so it is redacted and categorized. Called outside,
        # it escaped as a raw traceback carrying the unredacted OAuth request.
        if args.command == 'remove-bg':
            # Before the token exchange, as in the Node CLI: a bad flag combination should neither
            # cost a round-trip nor surface as [AUTH_ERROR]. The API takes exactly one of the two.
            transparent = args.transparent == 'true' if args.transparent else (not args.color)
            if args.color and transparent:
                raise ValueError("[VALIDATION_ERROR] --color and --transparent true cannot be used together")
            if not args.color and not transparent:
                raise ValueError("[VALIDATION_ERROR] --transparent false requires --color")

        token = get_token()

        if args.command == 'remove-bg':
            log('info', 'remove-bg')
            url_or_id = ensure_url_or_id(args.input, token)
            payload = {
                'image_url': url_or_id,
                'background_color': args.color,
                'transparent_background': transparent,
                'feather_width': args.feather,
                'trimap_url': args.trimap,
                'callback_url': args.callback
            }
            payload = {k: v for k, v in payload.items() if v is not None}
            r = _session.post(f"{BASE_URL}/images/remove-background", json=payload, headers=make_headers(args.sync), timeout=REQUEST_TIMEOUT)
            r.raise_for_status()
            print(json.dumps(r.json(), indent=2))
        elif args.command == 'color-match':
            log('info', 'color-match')
            url_or_id = ensure_url_or_id(args.input, token)
            payload = {
                'image_url': url_or_id,
                'color_markers': json.loads(args.markers),
                'callback_url': args.callback if hasattr(args, 'callback') else None
            }
            payload = {k: v for k, v in payload.items() if v is not None}
            r = _session.post(f"{BASE_URL}/images/color-matching", json=payload, headers=make_headers(args.sync), timeout=REQUEST_TIMEOUT)
            r.raise_for_status()
            print(json.dumps(r.json(), indent=2))
        elif args.command == 'create-mask':
            log('info', 'create-mask')
            url_or_id = ensure_url_or_id(args.input, token)
            payload = {
                'image_url': url_or_id,
                'feather_width': args.feather,
                'trimap_url': args.trimap,
                'callback_url': args.callback
            }
            payload = {k: v for k, v in payload.items() if v is not None}
            r = _session.post(f"{BASE_URL}/images/create-mask", json=payload, headers=make_headers(args.sync), timeout=REQUEST_TIMEOUT)
            r.raise_for_status()
            print(json.dumps(r.json(), indent=2))
        elif args.command == 'create-trimap':
            log('info', 'create-trimap')
            url_or_id = ensure_url_or_id(args.input, token)
            payload = {
                'image_url': url_or_id,
                'callback_url': args.callback
            }
            payload = {k: v for k, v in payload.items() if v is not None}
            r = _session.post(f"{BASE_URL}/images/create-trimap", json=payload, headers=make_headers(args.sync), timeout=REQUEST_TIMEOUT)
            r.raise_for_status()
            print(json.dumps(r.json(), indent=2))
        elif args.command == 'model-crop':
            log('info', 'model-crop')
            url_or_id = ensure_url_or_id(args.input, token)
            payload = {
                'image_url': url_or_id,
                'top_crop_location': args.top,
                'bottom_crop_location': args.bottom,
                'callback_url': args.callback
            }
            payload = {k: v for k, v in payload.items() if v is not None}
            r = _session.post(f"{BASE_URL}/images/model-crop", json=payload, headers=make_headers(args.sync), timeout=REQUEST_TIMEOUT)
            r.raise_for_status()
            print(json.dumps(r.json(), indent=2))
        elif args.command == 'status':
            validate_id(args.job_id, 'jobId')
            log('info', 'status', {'jobId': args.job_id})
            r = _session.get(f"{BASE_URL}/images/jobs/{args.job_id}/status", headers=make_headers(sync=True), timeout=REQUEST_TIMEOUT)
            r.raise_for_status()
            print(json.dumps(r.json(), indent=2))
        elif args.command == 'get-key':
            log('info', 'get-key')
            r = _session.get(f"{BASE_URL}/webhook/public-keys", headers=make_headers(sync=True), timeout=REQUEST_TIMEOUT)
            r.raise_for_status()
            print(json.dumps(r.json(), indent=2))

    except requests.exceptions.Timeout:
        log('error', f'{args.command} failed', {'error': 'timeout'})
        print("[TIMEOUT] Request timed out", file=sys.stderr)
        sys.exit(1)
    except requests.exceptions.ConnectionError as e:
        log('error', f'{args.command} failed', {'error': str(e)})
        msg = "[TIMEOUT] Request timed out" if _is_read_timeout(e) else f"[NETWORK_ERROR] {e}"
        print(redact_secrets(msg), file=sys.stderr)
        sys.exit(1)
    except requests.exceptions.HTTPError as e:
        status = e.response.status_code if e.response is not None else '?'
        log('error', f'{args.command} failed', {'error': f'HTTP {status}'})
        try:
            body = e.response.json()
            print(redact_secrets(f"[HTTP_{status}] {json.dumps(body, indent=2)}"), file=sys.stderr)
        except Exception:
            print(redact_secrets(f"[HTTP_{status}] {e.response.text}"), file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        log('error', f'{args.command} failed', {'error': str(e)})
        # Messages raised with their own category (e.g. [AUTH_ERROR]) keep it as-is.
        msg = str(e) if re.match(r'^\[[A-Z0-9_]+\]', str(e)) else f"[API_ERROR] {e}"
        print(redact_secrets(msg), file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
