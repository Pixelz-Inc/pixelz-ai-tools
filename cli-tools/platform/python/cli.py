import os
import sys
import json
import re
import requests

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '../../../shared/python')))
import pixelz_common
from pixelz_common import (
    validate_id, is_read_timeout as _is_read_timeout, PLATFORM_UPLOAD_EXTENSIONS, HEX_COLOR,
    resolve_status, check_api_error, is_url, int_arg, CliParser, RootParser)

pixelz_common.load_env(__file__)

# Overridable so tests can point at a local stub and assert the exact outgoing params.
BASE_URL = os.environ.get('PIXELZ_PLATFORM_BASE_URL', 'https://api.pixelz.com/REST.svc/JSON')
# Overridable so tests can exercise the timeout path without waiting 90 s.
REQUEST_TIMEOUT = float(os.environ.get('PIXELZ_REQUEST_TIMEOUT_SECONDS') or 90)

_session = pixelz_common.make_session()

# Credentials are matched in raw AND percent-encoded form: requests echoes the whole
# request URL in ConnectionError text, and Platform auth travels as query params, so a
# key containing + / = @ appears encoded there and a literal match silently misses it.
# The param-name pass is the backstop for any encoding these variants don't anticipate.
redact_secrets = pixelz_common.make_redactor(
    ('PIXELZ_PLATFORM_API_KEY', 'PIXELZ_PLATFORM_EMAIL'), ('contactAPIkey', 'contactEmail'))
log = pixelz_common.make_logger(redact_secrets)

STATUS_HELP = ('Any numeric Platform status code. Only these names are aliases: '
               'new (10), in production (60), production finished (70), delivered (80).')

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

def ensure_url(input_path):
    if not input_path:
        return None
    if is_url(input_path):
        return input_path
    resolved, file_size = pixelz_common.resolve_local_file(input_path, PLATFORM_UPLOAD_EXTENSIONS)

    auth = get_auth()
    file_name = os.path.basename(resolved)
    log('info', 'Requesting presigned URL', {'fileName': file_name})
    r = _session.post(f"{BASE_URL}/RequestPresignUrls", json={**auth, 'imageNames': [file_name]}, timeout=REQUEST_TIMEOUT)
    r.raise_for_status()
    target = pixelz_common.parse_platform_presign(r.json())
    upload_url = target['UploadUrl']
    download_url = target['DownloadUrl']

    log('info', 'Uploading file to S3', {'fileName': file_name, 'size': file_size})
    with open(resolved, 'rb') as f:
        r_put = _session.put(upload_url, data=f, headers={'Content-Type': 'application/octet-stream'}, timeout=REQUEST_TIMEOUT)
        r_put.raise_for_status()

    return download_url

def validate_args(args):
    """Local checks that must fail before any request, mirroring the Node CLI."""
    cmd = args.command
    missing = [f'<{n}>' for n in ('id', 'input', 'ticket', 'comment') if getattr(args, n, None) == '']
    if cmd == 'add-color-library' and any(not p for p in args.images):
        missing.append('<images>')
    if cmd == 'upload' and not args.template:
        missing.append('--template')
    if missing:
        raise ValueError(f"[VALIDATION_ERROR] {cmd} requires {', '.join(missing)}")
    if cmd == 'get-template':
        validate_id(args.id, 'templateId')
    elif cmd in ('status', 'delete', 'reject'):
        validate_id(args.ticket, 'imageTicket')
    if cmd == 'upload':
        if args.swatchColorCode is not None and not HEX_COLOR.fullmatch(args.swatchColorCode):
            raise ValueError("[VALIDATION_ERROR] --swatchColorCode must be a hex colour like #FF5733")
        if args.colorwayIds:
            try:
                parsed = json.loads(args.colorwayIds)
            except ValueError:
                raise ValueError("[VALIDATION_ERROR] --colorwayIds is not valid JSON") from None
            if not isinstance(parsed, list):
                raise ValueError("[VALIDATION_ERROR] --colorwayIds must be a JSON array, e.g. [123,456]")
            args.colorwayIds = parsed
    elif cmd == 'list-images':
        if args.imagesPerPage is not None and not 1 <= args.imagesPerPage <= 100:
            raise ValueError("[VALIDATION_ERROR] --imagesPerPage must be between 1 and 100")
        if args.sortBy is not None and args.sortBy not in ('id', 'date', 'status'):
            raise ValueError("[VALIDATION_ERROR] --sortBy must be one of: id, date, status")
        if args.isDescending is not None and args.isDescending not in ('true', 'false'):
            raise ValueError("[VALIDATION_ERROR] --isDescending must be true or false")

def main():
    parser = RootParser(description='Pixelz Platform CLI', epilog='--status: ' + STATUS_HELP)
    subparsers = parser.add_subparsers(dest='command', parser_class=CliParser)

    subparsers.add_parser('list-templates')

    get_template = subparsers.add_parser('get-template')
    get_template.add_argument('id')

    upload = subparsers.add_parser('upload')
    upload.add_argument('input')
    # Not required=True: argparse would name the missing flag "--template/--templateId".
    upload.add_argument('--template', '--templateId', dest='template')
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
    upload.add_argument('--swatchColorCode', help='Hex colour, e.g. #FF5733')
    upload.add_argument('--markerX', type=int_arg)
    upload.add_argument('--markerY', type=int_arg)
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
    stack.add_argument('--template', '--templateId', dest='template')
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
    list_images.add_argument('--status', '--imageStatus', dest='status', help=STATUS_HELP)
    list_images.add_argument('--excludeImageStatus', help=STATUS_HELP)
    list_images.add_argument('--productId')
    list_images.add_argument('--fromDate')
    list_images.add_argument('--toDate')
    list_images.add_argument('--page', type=int_arg)
    list_images.add_argument('--imagesPerPage', type=int_arg, help='1 to 100')
    list_images.add_argument('--sortBy', help='id, date or status')
    list_images.add_argument('--isDescending', help='true or false')

    count_images = subparsers.add_parser('count-images')
    count_images.add_argument('--status', '--imageStatus', dest='status', help=STATUS_HELP)
    count_images.add_argument('--fromDate')
    count_images.add_argument('--toDate')

    list_products = subparsers.add_parser('list-products')
    list_products.add_argument('--page', type=int_arg)
    list_products.add_argument('--per-page', '--perPage', dest='per_page', type=int_arg)

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
    get_invoices.add_argument('--page', type=int_arg)
    get_invoices.add_argument('--returnUrl')

    args = pixelz_common.parse_cli_args(parser)
    if args is None:
        return

    try:
        # Before credentials and before any request, as in the Node CLI.
        validate_args(args)
        auth = get_auth()

        def print_checked(r):
            r.raise_for_status()
            data = r.json()
            check_api_error(data)
            print(json.dumps(data, indent=2))

        if args.command == 'list-templates':
            log('info', 'list-templates')
            print_checked(_session.get(f"{BASE_URL}/Templates", params=auth, timeout=REQUEST_TIMEOUT))
        elif args.command == 'get-template':
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
                payload['colorwayIds'] = args.colorwayIds
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
            log('info', 'delete', {'ticket': args.ticket})
            payload = {**auth}
            if args.customer_id: payload['customerImageId'] = args.customer_id
            print_checked(_session.delete(f"{BASE_URL}/Image/{args.ticket}", json=payload, timeout=REQUEST_TIMEOUT))
        elif args.command == 'reject':
            log('info', 'reject', {'ticket': args.ticket})
            payload = {**auth, 'imageTicket': args.ticket, 'comment': args.comment}
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
