import os
import sys
import json
import re
import requests
from urllib.parse import quote, quote_plus
from urllib3.util.retry import Retry
from requests.adapters import HTTPAdapter
import argparse
from dotenv import load_dotenv

load_dotenv(os.environ.get('PIXELZ_DOTENV_PATH') or os.path.abspath(os.path.join(os.path.dirname(__file__), '../../../.env')))

# Overridable so tests can point at a local stub and assert the exact outgoing params.
BASE_URL = os.environ.get('PIXELZ_PLATFORM_BASE_URL', 'https://api.pixelz.com/REST.svc/JSON')

def redact_secrets(text):
    """Replace known credential values and bearer tokens in text with <REDACTED>.

    Credentials are matched in raw AND percent-encoded form: requests echoes the whole
    request URL in ConnectionError text, and Platform auth travels as query params, so a
    key containing + / = @ appears encoded there and a literal match silently misses it.
    The param-name pass is the backstop for any encoding these variants don't anticipate.
    """
    s = str(text)
    for key in ('PIXELZ_PLATFORM_API_KEY', 'PIXELZ_PLATFORM_EMAIL'):
        val = os.getenv(key)
        if not val:
            continue
        for variant in {val, quote(val, safe=''), quote_plus(val)}:
            s = s.replace(variant, '<REDACTED>')
    s = re.sub(r'(contactAPIkey|contactEmail)=[^&\s\'"]*', r'\1=<REDACTED>', s, flags=re.IGNORECASE)
    s = re.sub(r'eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', '<REDACTED>', s)
    return s
REQUEST_TIMEOUT = 90
MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024  # 2 GB

_retry = Retry(total=3, backoff_factor=1, status_forcelist=[429, 502, 503, 504], respect_retry_after_header=True)
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
    with open(_log_file, 'a') as f:
        f.write(entry + '\n')

STATUS_ALIASES = {
    'new': '10', 'in production': '60', 'production finished': '70', 'delivered': '80'
}

def resolve_status(value):
    if value is None:
        return value
    lower = str(value).lower()
    return STATUS_ALIASES.get(lower, value)

def validate_id(value, name):
    if not re.match(r'^[a-zA-Z0-9_\-]+$', value):
        raise ValueError(f"Invalid {name}: contains unexpected characters")

def get_auth():
    email = os.getenv('PIXELZ_PLATFORM_EMAIL')
    key = os.getenv('PIXELZ_PLATFORM_API_KEY')
    if not email or not key:
        # stderr, not stdout: callers parse stdout as JSON, so a diagnostic there would
        # surface as a JSON parse error instead of an actionable auth message.
        print("[AUTH_ERROR] Missing Platform API credentials.", file=sys.stderr)
        print("Required: PIXELZ_PLATFORM_EMAIL and PIXELZ_PLATFORM_API_KEY in .env file.", file=sys.stderr)
        sys.exit(1)
    return {'contactEmail': email, 'contactAPIkey': key}

def check_api_error(data):
    if isinstance(data, dict):
        code = data.get('ErrorCode')
        if code is not None and code != 'NoError' and code != 0:
            raise Exception(f"[API_ERROR] {code}: {data.get('Message', '')}")

def ensure_url(input_path):
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

    auth = get_auth()
    file_name = os.path.basename(resolved)
    log('info', 'Requesting presigned URL', {'fileName': file_name})
    r = _session.post(f"{BASE_URL}/RequestPresignUrls", json={**auth, 'imageNames': [file_name]}, timeout=REQUEST_TIMEOUT)
    r.raise_for_status()
    body = r.json()
    if isinstance(body, dict) and body.get('ErrorCode'):
        raise Exception(
            f"[PRESIGN_UNAVAILABLE] {body.get('Message', 'Presigned URL request failed')}. "
            "Your account is not enabled for direct file uploads. "
            "Provide a publicly accessible image URL instead of a local file path."
        )
    if not isinstance(body, list) or not body:
        raise Exception("RequestPresignUrls returned an unexpected response.")
    upload_url = body[0]['UploadUrl']
    download_url = body[0]['DownloadUrl']
    
    log('info', 'Uploading file to S3', {'fileName': file_name, 'size': file_size})
    with open(resolved, 'rb') as f:
        r_put = _session.put(upload_url, data=f, headers={'Content-Type': 'application/octet-stream'}, timeout=REQUEST_TIMEOUT)
        r_put.raise_for_status()

    return download_url

def main():
    parser = argparse.ArgumentParser(description='Pixelz Platform CLI')
    subparsers = parser.add_subparsers(dest='command')

    subparsers.add_parser('list-templates')
    
    get_template = subparsers.add_parser('get-template')
    get_template.add_argument('id')

    upload = subparsers.add_parser('upload')
    upload.add_argument('input')
    upload.add_argument('--template', required=True)
    upload.add_argument('--imageURL2')
    upload.add_argument('--imageURL3')
    upload.add_argument('--imageURL4')
    upload.add_argument('--imageURL5')
    upload.add_argument('--colorReferenceFileURL')
    upload.add_argument('--imageCallbackURL')
    upload.add_argument('--customerImageId')
    upload.add_argument('--productId')
    upload.add_argument('--customerFolder')
    upload.add_argument('--imageDeadlineDateTimeUTC')
    upload.add_argument('--comment')
    upload.add_argument('--markupImageUrl')
    upload.add_argument('--swatchImageURL')
    upload.add_argument('--swatchColorCode')
    upload.add_argument('--markerX', type=int)
    upload.add_argument('--markerY', type=int)
    upload.add_argument('--outputFileName')
    upload.add_argument('--customerImageColorID')
    upload.add_argument('--colorwayIds', help='JSON array of color library IDs, e.g. "[123,456]"')

    white_glove = subparsers.add_parser('white-glove')
    white_glove.add_argument('input')
    white_glove.add_argument('--imageURL2')
    white_glove.add_argument('--imageURL3')
    white_glove.add_argument('--imageURL4')
    white_glove.add_argument('--imageURL5')
    white_glove.add_argument('--comment')
    white_glove.add_argument('--markupImageUrl')
    white_glove.add_argument('--colorReferenceFileURL')
    white_glove.add_argument('--imageCallbackURL')
    white_glove.add_argument('--customerImageId')
    white_glove.add_argument('--productId')
    white_glove.add_argument('--customerFolder')

    stack = subparsers.add_parser('stack')
    stack.add_argument('input')
    stack.add_argument('--template')
    stack.add_argument('--imageURL2')
    stack.add_argument('--imageURL3')
    stack.add_argument('--imageURL4')
    stack.add_argument('--imageURL5')
    stack.add_argument('--colorReferenceFileURL')
    stack.add_argument('--imageCallbackURL')
    stack.add_argument('--customerImageId')
    stack.add_argument('--productId')
    stack.add_argument('--customerFolder')
    stack.add_argument('--imageDeadlineDateTimeUTC')

    status = subparsers.add_parser('status')
    status.add_argument('ticket')
    status.add_argument('--customer-id', '--customerImageId', dest='customer_id')

    list_images = subparsers.add_parser('list-images')
    list_images.add_argument('--status', '--imageStatus', dest='status')
    list_images.add_argument('--excludeImageStatus')
    list_images.add_argument('--productId')
    list_images.add_argument('--fromDate')
    list_images.add_argument('--toDate')
    list_images.add_argument('--page', type=int)
    list_images.add_argument('--imagesPerPage', type=int)
    list_images.add_argument('--sortBy')
    list_images.add_argument('--isDescending')

    count_images = subparsers.add_parser('count-images')
    count_images.add_argument('--status', '--imageStatus', dest='status')
    count_images.add_argument('--fromDate')
    count_images.add_argument('--toDate')

    list_products = subparsers.add_parser('list-products')
    list_products.add_argument('--page', type=int)
    list_products.add_argument('--per-page', type=int)

    delete = subparsers.add_parser('delete')
    delete.add_argument('ticket')
    delete.add_argument('--customer-id', '--customerImageId', dest='customer_id')

    reject = subparsers.add_parser('reject')
    reject.add_argument('ticket')
    reject.add_argument('comment')
    reject.add_argument('--customer-id', '--customerImageId', dest='customer_id')
    reject.add_argument('--markupImageUrl')

    subparsers.add_parser('get-contact')

    add_color_lib = subparsers.add_parser('add-color-library')
    add_color_lib.add_argument('images', nargs='+', help='One or more local paths or URLs of swatch images')

    get_invoices = subparsers.add_parser('get-invoices')
    get_invoices.add_argument('--fromDate')
    get_invoices.add_argument('--toDate')
    get_invoices.add_argument('--page', type=int)
    get_invoices.add_argument('--returnUrl')

    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        return

    auth = get_auth()

    try:
        def print_checked(r):
            r.raise_for_status()
            data = r.json()
            check_api_error(data)
            print(json.dumps(data, indent=2))

        if args.command == 'list-templates':
            log('info', 'list-templates')
            print_checked(_session.get(f"{BASE_URL}/Templates", params=auth, timeout=REQUEST_TIMEOUT))
        elif args.command == 'get-template':
            validate_id(args.id, 'templateId')
            log('info', 'get-template', {'id': args.id})
            print_checked(_session.get(f"{BASE_URL}/Template/{args.id}", params=auth, timeout=REQUEST_TIMEOUT))
        elif args.command == 'upload':
            log('info', 'upload', {'template': args.template})
            url = ensure_url(args.input)
            payload = {**auth, 'imageURL': url, 'templateId': args.template}
            for key in ['imageURL2', 'imageURL3', 'imageURL4', 'imageURL5', 'colorReferenceFileURL',
                        'imageCallbackURL', 'customerImageId', 'productId', 'customerFolder',
                        'imageDeadlineDateTimeUTC', 'comment', 'markupImageUrl', 'swatchImageURL',
                        'swatchColorCode', 'markerX', 'markerY', 'outputFileName', 'customerImageColorID']:
                val = getattr(args, key, None)
                if val is not None:
                    payload[key] = val
            if args.colorwayIds:
                payload['colorwayIds'] = json.loads(args.colorwayIds)
            print_checked(_session.post(f"{BASE_URL}/Image", json=payload, timeout=REQUEST_TIMEOUT))
        elif args.command == 'white-glove':
            log('info', 'white-glove')
            url = ensure_url(args.input)
            payload = {**auth, 'imageURL': url}
            for key in ['imageURL2', 'imageURL3', 'imageURL4', 'imageURL5', 'comment', 'markupImageUrl',
                        'colorReferenceFileURL', 'imageCallbackURL', 'customerImageId', 'productId', 'customerFolder']:
                val = getattr(args, key, None)
                if val is not None:
                    payload[key] = val
            print_checked(_session.post(f"{BASE_URL}/WhiteGloveService", json=payload, timeout=REQUEST_TIMEOUT))
        elif args.command == 'stack':
            log('info', 'stack')
            url = ensure_url(args.input)
            payload = {**auth, 'imageURL': url}
            if args.template: payload['templateId'] = args.template
            for key in ['imageURL2', 'imageURL3', 'imageURL4', 'imageURL5', 'colorReferenceFileURL',
                        'imageCallbackURL', 'customerImageId', 'productId', 'customerFolder', 'imageDeadlineDateTimeUTC']:
                val = getattr(args, key, None)
                if val is not None:
                    payload[key] = val
            print_checked(_session.post(f"{BASE_URL}/StackImage", json=payload, timeout=REQUEST_TIMEOUT))
        elif args.command == 'status':
            validate_id(args.ticket, 'imageTicket')
            log('info', 'status', {'ticket': args.ticket})
            params = {**auth}
            if args.customer_id: params['customerImageId'] = args.customer_id
            print_checked(_session.get(f"{BASE_URL}/Image/{args.ticket}", params=params, timeout=REQUEST_TIMEOUT))
        elif args.command == 'list-images':
            log('info', 'list-images')
            params = {**auth}
            # The API param is `imageStatus`, not `status` — sending `status` silently
            # returned unfiltered results (PixelzPlatformAPIdocs.txt, "GET Images List").
            if args.status: params['imageStatus'] = resolve_status(args.status)
            if args.excludeImageStatus: params['excludeImageStatus'] = resolve_status(args.excludeImageStatus)
            for key in ['productId', 'fromDate', 'toDate', 'page', 'imagesPerPage', 'sortBy', 'isDescending']:
                val = getattr(args, key, None)
                if val is not None:
                    params[key] = val
            print_checked(_session.get(f"{BASE_URL}/Images", params=params, timeout=REQUEST_TIMEOUT))
        elif args.command == 'count-images':
            log('info', 'count-images')
            params = {**auth}
            if args.status: params['imageStatus'] = resolve_status(args.status)
            for key in ['fromDate', 'toDate']:
                val = getattr(args, key, None)
                if val is not None:
                    params[key] = val
            print_checked(_session.get(f"{BASE_URL}/Images/Count", params=params, timeout=REQUEST_TIMEOUT))
        elif args.command == 'list-products':
            log('info', 'list-products')
            params = {k: v for k, v in {**auth, 'page': args.page, 'productIdsPerPage': args.per_page}.items() if v is not None}
            print_checked(_session.get(f"{BASE_URL}/ProductIds", params=params, timeout=REQUEST_TIMEOUT))
        elif args.command == 'delete':
            validate_id(args.ticket, 'imageTicket')
            log('info', 'delete', {'ticket': args.ticket})
            payload = {**auth}
            if args.customer_id: payload['customerImageId'] = args.customer_id
            print_checked(_session.delete(f"{BASE_URL}/Image/{args.ticket}", json=payload, timeout=REQUEST_TIMEOUT))
        elif args.command == 'reject':
            validate_id(args.ticket, 'imageTicket')
            log('info', 'reject', {'ticket': args.ticket})
            payload = {**auth, 'comment': args.comment}
            if args.customer_id: payload['customerImageId'] = args.customer_id
            if args.markupImageUrl: payload['markupImageUrl'] = args.markupImageUrl
            print_checked(_session.put(f"{BASE_URL}/Image/Reject/{args.ticket}", json=payload, timeout=REQUEST_TIMEOUT))
        elif args.command == 'get-contact':
            log('info', 'get-contact')
            print_checked(_session.get(f"{BASE_URL}/Contact", params=auth, timeout=REQUEST_TIMEOUT))
        elif args.command == 'add-color-library':
            log('info', 'add-color-library', {'count': len(args.images)})
            resolved_urls = [ensure_url(p) for p in args.images]
            payload = {**auth, 'imagesUrl': resolved_urls}
            print_checked(_session.post(f"{BASE_URL}/AddColorLibrary", json=payload, timeout=REQUEST_TIMEOUT))
        elif args.command == 'get-invoices':
            log('info', 'get-invoices')
            params = {**auth}
            for key in ['fromDate', 'toDate', 'page', 'returnUrl']:
                val = getattr(args, key, None)
                if val is not None:
                    params[key] = val
            print_checked(_session.get(f"{BASE_URL}/Invoices", params=params, timeout=REQUEST_TIMEOUT))

    except requests.exceptions.Timeout:
        log('error', f'{args.command} failed', {'error': 'timeout'})
        print("[TIMEOUT] Request timed out", file=sys.stderr)
        sys.exit(1)
    except requests.exceptions.ConnectionError as e:
        log('error', f'{args.command} failed', {'error': str(e)})
        print(redact_secrets(f"[NETWORK_ERROR] {e}"), file=sys.stderr)
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
        print(redact_secrets(f"[API_ERROR] {e}"), file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
