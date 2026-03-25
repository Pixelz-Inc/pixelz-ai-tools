import os
import sys
import json
import re
import time
import mimetypes
import requests
import argparse
from dotenv import load_dotenv

load_dotenv(os.environ.get('PIXELZ_DOTENV_PATH') or os.path.abspath(os.path.join(os.path.dirname(__file__), '../../../.env')))

AUTH_URL = 'https://id.pixelz.com/realms/pixelz-automations/protocol/openid-connect/token'
BASE_URL = 'https://automation-api.pixelz.com/v1'
REQUEST_TIMEOUT = 90
MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024  # 2 GB

_log_file = os.getenv('PIXELZ_LOG_FILE')

def log(level, message, data=None):
    if not _log_file:
        return
    from datetime import datetime, timezone
    entry = f"[{datetime.now(timezone.utc).isoformat()}] [{level}] {message}"
    if data is not None:
        entry += f" {json.dumps(data, default=str)}"
    with open(_log_file, 'a') as f:
        f.write(entry + '\n')

def validate_id(value, name):
    if not re.match(r'^[a-zA-Z0-9_\-]+$', value):
        raise ValueError(f"Invalid {name}: contains unexpected characters")

_token_cache = {'token': None, 'expires_at': 0}

def get_token():
    if _token_cache['token'] and time.time() < _token_cache['expires_at']:
        return _token_cache['token']
    cid = os.getenv('PIXELZ_AUTOMATION_CLIENT_ID')
    sec = os.getenv('PIXELZ_AUTOMATION_CLIENT_SECRET')
    if not cid or not sec:
        print("[AUTH_ERROR] Missing Automation API credentials.")
        print("Required: PIXELZ_AUTOMATION_CLIENT_ID and PIXELZ_AUTOMATION_CLIENT_SECRET in .env file.")
        sys.exit(1)

    log('info', 'Requesting new OAuth token')
    r = requests.post(AUTH_URL, data={'grant_type': 'client_credentials', 'client_id': cid, 'client_secret': sec}, timeout=REQUEST_TIMEOUT)
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
    file_size = os.path.getsize(input_path)
    if file_size > MAX_FILE_SIZE:
        raise Exception(f"File too large ({file_size / (1024**3):.2f} GB). Maximum allowed size is 2 GB.")
    headers = {'Authorization': f'Bearer {token}'}
    file_name = os.path.basename(input_path)
    log('info', 'Requesting upload URL', {'fileName': file_name})
    r = requests.post(f"{BASE_URL}/files/request-upload-url", json={'fileName': file_name}, headers=headers, timeout=REQUEST_TIMEOUT)
    r.raise_for_status()
    upload_url = r.json()['url']
    content_type = mimetypes.guess_type(input_path)[0] or 'application/octet-stream'
    log('info', 'Uploading file', {'fileName': file_name, 'size': file_size})
    with open(input_path, 'rb') as f:
        r_put = requests.put(upload_url, data=f, headers={'Content-Type': content_type}, timeout=REQUEST_TIMEOUT)
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

    token = get_token()

    def make_headers(sync=False):
        h = {'Authorization': f'Bearer {token}'}
        if not sync:
            h['Respond-Mode'] = 'async'
        return h

    try:
        if args.command == 'remove-bg':
            log('info', 'remove-bg')
            url_or_id = ensure_url_or_id(args.input, token)
            payload = {
                'image_url': url_or_id,
                'background_color': args.color,
                'transparent_background': args.transparent == 'true' if args.transparent else (not args.color),
                'feather_width': args.feather,
                'trimap_url': args.trimap,
                'callback_url': args.callback
            }
            payload = {k: v for k, v in payload.items() if v is not None}
            r = requests.post(f"{BASE_URL}/images/remove-background", json=payload, headers=make_headers(args.sync), timeout=REQUEST_TIMEOUT)
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
            r = requests.post(f"{BASE_URL}/images/color-matching", json=payload, headers=make_headers(args.sync), timeout=REQUEST_TIMEOUT)
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
            r = requests.post(f"{BASE_URL}/images/create-mask", json=payload, headers=make_headers(args.sync), timeout=REQUEST_TIMEOUT)
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
            r = requests.post(f"{BASE_URL}/images/create-trimap", json=payload, headers=make_headers(args.sync), timeout=REQUEST_TIMEOUT)
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
            r = requests.post(f"{BASE_URL}/images/model-crop", json=payload, headers=make_headers(args.sync), timeout=REQUEST_TIMEOUT)
            r.raise_for_status()
            print(json.dumps(r.json(), indent=2))
        elif args.command == 'status':
            validate_id(args.job_id, 'jobId')
            log('info', 'status', {'jobId': args.job_id})
            r = requests.get(f"{BASE_URL}/images/jobs/{args.job_id}/status", headers=make_headers(sync=True), timeout=REQUEST_TIMEOUT)
            r.raise_for_status()
            print(json.dumps(r.json(), indent=2))
        elif args.command == 'get-key':
            log('info', 'get-key')
            r = requests.get(f"{BASE_URL}/webhook/public-keys", headers=make_headers(sync=True), timeout=REQUEST_TIMEOUT)
            r.raise_for_status()
            print(json.dumps(r.json(), indent=2))

    except Exception as e:
        log('error', f'{args.command} failed', {'error': str(e)})
        print(f"[API_ERROR] {str(e)}", file=sys.stderr)
        if hasattr(e, 'response') and e.response is not None:
            print(e.response.text, file=sys.stderr)

if __name__ == "__main__":
    main()
