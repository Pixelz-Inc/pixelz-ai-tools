import os
import sys
import json
import re
import time
import threading
import requests

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '../../../shared/python')))
import pixelz_common
from pixelz_common import (
    validate_id, is_read_timeout as _is_read_timeout, AUTOMATION_UPLOAD_EXTENSIONS, AUTOMATION_MIME_TYPES,
    HEX_COLOR, CROP_LOCATIONS, UPLOAD_UNAVAILABLE, is_url, float_arg, true_false_arg, CliParser, RootParser)

pixelz_common.load_env(__file__)

# Overridable so tests can point at a local stub and assert the exact outgoing payload.
AUTH_URL = os.environ.get('PIXELZ_AUTOMATION_AUTH_URL', 'https://id.pixelz.com/realms/pixelz-automations/protocol/openid-connect/token')
BASE_URL = os.environ.get('PIXELZ_AUTOMATION_BASE_URL', 'https://automation-api.pixelz.com/v1')
# Overridable so tests can exercise the timeout path without waiting 90 s.
REQUEST_TIMEOUT = float(os.environ.get('PIXELZ_REQUEST_TIMEOUT_SECONDS') or 90)

_session = pixelz_common.make_session()

# Credentials are matched in raw AND percent-encoded form. Automation creds travel in a
# form-encoded POST body, so they appear percent-encoded wherever requests echoes that
# body or a redirected URL, and a literal match would silently miss them. The param-name
# pass is the backstop for any encoding these variants don't anticipate.
redact_secrets = pixelz_common.make_redactor(
    ('PIXELZ_AUTOMATION_CLIENT_ID', 'PIXELZ_AUTOMATION_CLIENT_SECRET'), ('client_id', 'client_secret'))
log = pixelz_common.make_logger(redact_secrets)

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

def check_local_input(input_path):
    """Rejects a bad local file before the token exchange, so it costs no round-trip."""
    if not is_url(input_path):
        pixelz_common.resolve_local_file(input_path, AUTOMATION_UPLOAD_EXTENSIONS)

def ensure_url_or_id(input_path, token):
    if not input_path:
        return None
    if is_url(input_path):
        return input_path
    resolved, file_size = pixelz_common.resolve_local_file(input_path, AUTOMATION_UPLOAD_EXTENSIONS)
    headers = {'Authorization': f'Bearer {token}'}
    file_name = os.path.basename(resolved)
    log('info', 'Requesting upload URL', {'fileName': file_name})
    r = _session.post(f"{BASE_URL}/files/request-upload-url", json={'fileName': file_name}, headers=headers, timeout=REQUEST_TIMEOUT)
    if r.status_code == 403:
        raise Exception(UPLOAD_UNAVAILABLE)
    r.raise_for_status()
    body = r.json()
    upload_url = body.get('url') if isinstance(body, dict) else None
    if not upload_url:
        raise Exception("Upload URL request returned an unexpected response.")
    # The allowlist keeps this a known type; octet-stream only applies under PIXELZ_UPLOAD_ANY_FILE_TYPE.
    content_type = AUTOMATION_MIME_TYPES.get(os.path.splitext(input_path)[1].lower(), 'application/octet-stream')
    log('info', 'Uploading file', {'fileName': file_name, 'size': file_size})
    with open(resolved, 'rb') as f:
        r_put = _session.put(upload_url, data=f, headers={'Content-Type': content_type}, timeout=REQUEST_TIMEOUT)
        r_put.raise_for_status()
    return upload_url

def _is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)

def _validation_error(message):
    return ValueError(f"[VALIDATION_ERROR] {message}")

def parse_markers(text):
    """Validate MARKERS_JSON against the API's ColorMarker schema; return the parsed markers."""
    try:
        markers = json.loads(text)
    except ValueError:
        raise _validation_error('MARKERS_JSON is not valid JSON') from None
    if not isinstance(markers, list) or not markers:
        raise _validation_error('MARKERS_JSON must be a non-empty JSON array of markers')
    for i, m in enumerate(markers):
        at = f'MARKERS_JSON[{i}]'
        if not isinstance(m, dict):
            raise _validation_error(f'{at} must be an object')
        if not _is_int(m.get('x_coordinate')) or not _is_int(m.get('y_coordinate')):
            raise _validation_error(f'{at} needs integer x_coordinate and y_coordinate')
        has_color = m.get('swatch_color_code') is not None
        has_image = m.get('swatch_image') is not None
        if has_color == has_image:
            raise _validation_error(f'{at} needs exactly one of swatch_color_code or swatch_image')
        if has_color and not (isinstance(m['swatch_color_code'], str) and HEX_COLOR.fullmatch(m['swatch_color_code'])):
            raise _validation_error(f'{at}.swatch_color_code must be a hex colour like #FF5733')
        if has_image:
            s = m['swatch_image']
            if not (isinstance(s, dict) and isinstance(s.get('swatch_image_url'), str) and s['swatch_image_url']
                    and _is_int(s.get('x_coordinate')) and _is_int(s.get('y_coordinate'))):
                raise _validation_error(f'{at}.swatch_image needs swatch_image_url and integer x_coordinate and y_coordinate')
    return markers

def validate_args(args):
    """Local checks that must fail before any request, mirroring the Node CLI. Returns the parsed markers, if any."""
    cmd = args.command
    missing = [f'<{n}>' for n in ('input', 'markers', 'job_id') if getattr(args, n, None) == '']
    if missing:
        raise _validation_error(f"{cmd} requires {', '.join(missing)}")
    markers = None
    if cmd == 'status':
        validate_id(args.job_id, 'jobId')
    if cmd == 'remove-bg':
        if args.color is not None and not HEX_COLOR.fullmatch(args.color):
            raise _validation_error('--color must be a hex colour like #FF5733')
    if cmd in ('remove-bg', 'create-mask') and args.feather is not None and args.feather < 0:
        raise _validation_error('--feather must be >= 0')
    if cmd == 'remove-bg':
        # The API takes exactly one of the two ("do not set both, and do not leave both unset").
        transparent = args.transparent == 'true' if args.transparent else (not args.color)
        if args.color and transparent:
            raise _validation_error('--color and --transparent true cannot be used together')
        if not args.color and not transparent:
            raise _validation_error('--transparent false requires --color')
        args.transparent = transparent
    elif cmd == 'color-match':
        markers = parse_markers(args.markers)
    elif cmd == 'model-crop':
        if args.top is None and args.bottom is None:
            raise _validation_error('model-crop requires at least one of --top or --bottom')
        for flag, value in (('--top', args.top), ('--bottom', args.bottom)):
            if value is not None and value not in CROP_LOCATIONS:
                raise _validation_error(f"{flag} must be one of: {', '.join(CROP_LOCATIONS)}")
    if cmd in ('remove-bg', 'color-match', 'create-mask', 'create-trimap', 'model-crop'):
        check_local_input(args.input)
    return markers

def main():
    parser = RootParser(description='Pixelz Automation CLI')
    subparsers = parser.add_subparsers(dest='command', parser_class=CliParser)

    remove_bg = subparsers.add_parser('remove-bg')
    remove_bg.add_argument('input')
    remove_bg.add_argument('--color', help='Background colour as #RRGGBB (not with --transparent true)')
    remove_bg.add_argument('--transparent', type=true_false_arg, metavar='{true,false}')
    remove_bg.add_argument('--feather', type=float_arg)
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
    create_mask.add_argument('--feather', type=float_arg)
    create_mask.add_argument('--trimap')
    create_mask.add_argument('--callback')
    create_mask.add_argument('--sync', action='store_true')

    create_trimap = subparsers.add_parser('create-trimap')
    create_trimap.add_argument('input')
    create_trimap.add_argument('--callback')
    create_trimap.add_argument('--sync', action='store_true')

    model_crop = subparsers.add_parser('model-crop')
    model_crop.add_argument('input')
    model_crop.add_argument('--top', help='At least one of --top / --bottom. One of: ' + ', '.join(CROP_LOCATIONS))
    model_crop.add_argument('--bottom')
    model_crop.add_argument('--callback')
    model_crop.add_argument('--sync', action='store_true')

    status = subparsers.add_parser('status')
    status.add_argument('job_id')

    subparsers.add_parser('get-key')

    args = pixelz_common.parse_cli_args(parser)
    if args is None:
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
        # Validation comes first, as in the Node CLI: a bad argument should neither cost a
        # round-trip nor surface as [AUTH_ERROR].
        markers = validate_args(args)

        token = get_token()

        if args.command == 'remove-bg':
            log('info', 'remove-bg')
            url_or_id = ensure_url_or_id(args.input, token)
            payload = {
                'image_url': url_or_id,
                'background_color': args.color,
                'transparent_background': args.transparent,
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
                'color_markers': markers,
                'callback_url': args.callback
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
