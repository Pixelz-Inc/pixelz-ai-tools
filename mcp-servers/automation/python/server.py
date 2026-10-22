import os
import json
import re
import time
import threading
import mimetypes
import requests
from urllib.parse import quote, quote_plus
from urllib3.util.retry import Retry
from requests.adapters import HTTPAdapter
from dotenv import load_dotenv
from mcp.server.mcpserver import MCPServer
from mcp.server.caching import CacheHint

_dotenv_path = os.environ.get('PIXELZ_DOTENV_PATH') or os.path.abspath(os.path.join(os.path.dirname(__file__), '../../../.env'))
load_dotenv(_dotenv_path)

# The tool list is static and carries no per-account data, so clients can cache it and
# shared intermediaries may too (SEP-2549). Mirrors the Node server's cacheHints.
mcp = MCPServer(
    "pixelz-automation-mcp",
    cache_hints={"tools/list": CacheHint(ttl_ms=3_600_000, scope="public")},
)
AUTH_URL = 'https://id.pixelz.com/realms/pixelz-automations/protocol/openid-connect/token'
BASE_URL = 'https://automation-api.pixelz.com/v1'
REQUEST_TIMEOUT = 90
MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024  # 2 GB

_retry = Retry(total=3, backoff_factor=1, status_forcelist=[429, 502, 503, 504], respect_retry_after_header=True)
_session = requests.Session()
_session.mount('https://', HTTPAdapter(max_retries=_retry))
_session.mount('http://', HTTPAdapter(max_retries=_retry))

_log_file = os.getenv('PIXELZ_LOG_FILE')

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
            raise ValueError("[AUTH_ERROR] Missing PIXELZ_AUTOMATION_CLIENT_ID or PIXELZ_AUTOMATION_CLIENT_SECRET in .env")
        log('info', 'Requesting new OAuth token')
        r = _session.post(AUTH_URL, data={'grant_type': 'client_credentials', 'client_id': cid, 'client_secret': sec}, timeout=REQUEST_TIMEOUT)
        r.raise_for_status()
        data = r.json()
        _token_cache['token'] = data['access_token']
        _token_cache['expires_at'] = time.time() + (data.get('expires_in', 3600) - 60)
        return _token_cache['token']

def ensure_url_or_id(input_path, token):
    if not input_path: return None
    if input_path.startswith(('http://', 'https://')): return input_path
    if not os.path.exists(input_path): raise Exception(f"Local file not found: {input_path}")
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
        _session.put(upload_url, data=f, headers={'Content-Type': content_type}, timeout=REQUEST_TIMEOUT).raise_for_status()
    return upload_url

def api_headers(token, sync=False):
    h = {'Authorization': f'Bearer {token}'}
    if not sync:
        h['Respond-Mode'] = 'async'
    return h

CROP_LOCATIONS = [
    'eye_higher', 'below_eye', 'btw_eye_and_nose', 'below_nose',
    'between_nose_and_mouth', 'below_mouth', 'below_chin', 'chest',
    'at_elbow_higher', 'at_elbow_lower', 'waist', 'below_buttock',
    'main_body_axis', 'mid_thigh', 'above_knee', 'at_knee', 'below_knee'
]

def _format_error(tool_name, e):
    """Format errors with categorized prefixes matching Node.js MCP parity."""
    if isinstance(e, requests.exceptions.Timeout):
        msg = f"[TIMEOUT] Request timed out after {REQUEST_TIMEOUT} seconds"
    elif isinstance(e, requests.exceptions.ConnectionError):
        msg = f"[NETWORK_ERROR] {e}"
    elif isinstance(e, requests.exceptions.HTTPError) and e.response is not None:
        status = e.response.status_code
        try:
            body = e.response.json()
            msg = f"[HTTP_{status}] {json.dumps(body)}"
        except Exception:
            msg = f"[HTTP_{status}] {e.response.text}"
    elif isinstance(e, ValueError) and not str(e).startswith('[AUTH_ERROR]'):
        msg = f"[VALIDATION_ERROR] {e}"
    else:
        msg = str(e)
    msg = redact_secrets(msg)
    log('error', f'{tool_name} failed', {'error': msg})
    return f"Error: {msg}"

def _validate_required_str(value, name):
    if not value or not str(value).strip():
        raise ValueError(f"{name}: must be a non-empty string")

def _validate_hex_color(value, name):
    if value is not None and not re.match(r'^#[0-9A-Fa-f]{6}$', value):
        raise ValueError(f"{name}: must be a hex color like #FFFFFF")

def _validate_crop_location(value, name):
    if value is not None and value not in CROP_LOCATIONS:
        raise ValueError(f"{name}: must be one of {', '.join(CROP_LOCATIONS)}")

@mcp.tool()
def remove_background(imagePath: str, backgroundColor: str = None, transparentBackground: bool = None,
                      featherWidth: float = None, trimapUrl: str = None, callbackUrl: str = None,
                      sync: bool = False) -> str:
    """AI-powered background removal. Default: async — returns job_id immediately. Most jobs finish in 30-60 seconds; call get_job_status once to check, never in a loop. featherWidth softens edges (0-1=sharp, >1=soft). Pass trimapUrl from create_trimap for complex edges. Set sync=True only if the user explicitly requests it (risk of timeout)."""
    try:
        _validate_required_str(imagePath, 'imagePath')
        _validate_hex_color(backgroundColor, 'backgroundColor')
        if featherWidth is not None and featherWidth < 0:
            raise ValueError("featherWidth: must be >= 0")
        # The API takes exactly one of the two ("do not set both, and do not leave both unset"),
        # so transparency defaults to the opposite of whether a color was given.
        if transparentBackground is None:
            transparentBackground = not backgroundColor
        if backgroundColor and transparentBackground:
            raise ValueError("backgroundColor and transparentBackground=true cannot be used together")
        if not backgroundColor and not transparentBackground:
            raise ValueError("transparentBackground=false requires backgroundColor: set backgroundColor, or leave transparentBackground unset/true")
        log('info', 'Tool called: remove_background')
        token = get_token()
        url = ensure_url_or_id(imagePath, token)
        payload = {k: v for k, v in {
            'image_url': url, 'background_color': backgroundColor,
            'transparent_background': transparentBackground,
            'feather_width': featherWidth, 'trimap_url': trimapUrl, 'callback_url': callbackUrl
        }.items() if v is not None}
        r = _session.post(f"{BASE_URL}/images/remove-background", json=payload, headers=api_headers(token, sync), timeout=REQUEST_TIMEOUT)
        r.raise_for_status()
        return json.dumps(r.json(), indent=2)
    except Exception as e:
        return _format_error('remove_background', e)

@mcp.tool()
def color_matching(imagePath: str, colorMarkers: list, callbackUrl: str = None, sync: bool = False) -> str:
    """AI-powered color correction. Default: async — returns job_id immediately. Most jobs finish in 30-60 seconds; call get_job_status once to check, never in a loop. colorMarkers is an array of objects with x_coordinate, y_coordinate, and either swatch_color_code (hex) or swatch_image. Set sync=True only if the user explicitly requests it."""
    try:
        _validate_required_str(imagePath, 'imagePath')
        if not colorMarkers or not isinstance(colorMarkers, list) or len(colorMarkers) == 0:
            raise ValueError("colorMarkers: must be a non-empty array")
        log('info', 'Tool called: color_matching')
        token = get_token()
        url = ensure_url_or_id(imagePath, token)
        payload = {k: v for k, v in {'image_url': url, 'color_markers': colorMarkers, 'callback_url': callbackUrl}.items() if v is not None}
        r = _session.post(f"{BASE_URL}/images/color-matching", json=payload, headers=api_headers(token, sync), timeout=REQUEST_TIMEOUT)
        r.raise_for_status()
        return json.dumps(r.json(), indent=2)
    except Exception as e:
        return _format_error('color_matching', e)

@mcp.tool()
def create_mask(imagePath: str, featherWidth: float = None, trimapUrl: str = None, callbackUrl: str = None,
                sync: bool = False) -> str:
    """Generate a greyscale silhouette mask (white=subject, black=background). Default: async — returns job_id immediately. Most jobs finish in 30-60 seconds; call get_job_status once to check, never in a loop. Set sync=True only if the user explicitly requests it."""
    try:
        _validate_required_str(imagePath, 'imagePath')
        if featherWidth is not None and featherWidth < 0:
            raise ValueError("featherWidth: must be >= 0")
        log('info', 'Tool called: create_mask')
        token = get_token()
        url = ensure_url_or_id(imagePath, token)
        payload = {k: v for k, v in {'image_url': url, 'feather_width': featherWidth, 'trimap_url': trimapUrl, 'callback_url': callbackUrl}.items() if v is not None}
        r = _session.post(f"{BASE_URL}/images/create-mask", json=payload, headers=api_headers(token, sync), timeout=REQUEST_TIMEOUT)
        r.raise_for_status()
        return json.dumps(r.json(), indent=2)
    except Exception as e:
        return _format_error('create_mask', e)

@mcp.tool()
def create_trimap(imagePath: str, callbackUrl: str = None, sync: bool = False) -> str:
    """Generate a trimap for complex subjects (hair, fur, transparent edges). Default: async — returns job_id. Pass result trimapUrl to remove_background or create_mask for higher quality edges. Set sync=True only if the user explicitly requests it."""
    try:
        _validate_required_str(imagePath, 'imagePath')
        log('info', 'Tool called: create_trimap')
        token = get_token()
        url = ensure_url_or_id(imagePath, token)
        payload = {k: v for k, v in {'image_url': url, 'callback_url': callbackUrl}.items() if v is not None}
        r = _session.post(f"{BASE_URL}/images/create-trimap", json=payload, headers=api_headers(token, sync), timeout=REQUEST_TIMEOUT)
        r.raise_for_status()
        return json.dumps(r.json(), indent=2)
    except Exception as e:
        return _format_error('create_trimap', e)

@mcp.tool()
def model_crop(imagePath: str, topCropLocation: str = None, bottomCropLocation: str = None,
               callbackUrl: str = None, sync: bool = False) -> str:
    """Crop a model photograph using anatomical landmarks. Default: async — returns job_id immediately. Most jobs finish in 30-60 seconds; call get_job_status once to check, never in a loop. Valid locations: eye_higher, below_eye, btw_eye_and_nose, below_nose, between_nose_and_mouth, below_mouth, below_chin, chest, at_elbow_higher, at_elbow_lower, waist, below_buttock, main_body_axis, mid_thigh, above_knee, at_knee, below_knee. Set sync=True only if the user explicitly requests it."""
    try:
        _validate_required_str(imagePath, 'imagePath')
        _validate_crop_location(topCropLocation, 'topCropLocation')
        _validate_crop_location(bottomCropLocation, 'bottomCropLocation')
        log('info', 'Tool called: model_crop')
        token = get_token()
        url = ensure_url_or_id(imagePath, token)
        payload = {k: v for k, v in {'image_url': url, 'top_crop_location': topCropLocation, 'bottom_crop_location': bottomCropLocation, 'callback_url': callbackUrl}.items() if v is not None}
        r = _session.post(f"{BASE_URL}/images/model-crop", json=payload, headers=api_headers(token, sync), timeout=REQUEST_TIMEOUT)
        r.raise_for_status()
        return json.dumps(r.json(), indent=2)
    except Exception as e:
        return _format_error('model_crop', e)

@mcp.tool()
def get_job_status(jobId: str) -> str:
    """Check the status of any async Automation job. Most jobs finish in 30-60 seconds; large images can take several minutes. Call this once per check — never loop on it, since you cannot wait out an interval mid-turn. Read status.status_name: Created/ReadyForProcess/Processing = still working, report status and check again later; Completed or Delivered = result.result_image_url is ready; Failed = report the error to the user and ask whether to resubmit."""
    try:
        validate_id(jobId, 'jobId')
        log('info', 'Tool called: get_job_status', {'jobId': jobId})
        r = _session.get(f"{BASE_URL}/images/jobs/{jobId}/status", headers={'Authorization': f'Bearer {get_token()}'}, timeout=REQUEST_TIMEOUT)
        r.raise_for_status()
        return json.dumps(r.json(), indent=2)
    except Exception as e:
        return _format_error('get_job_status', e)

@mcp.tool()
def get_webhook_public_key() -> str:
    """Retrieve the ECDSA public key used to verify Pixelz Automation webhook payload signatures. Store this key in your application to validate incoming webhook requests."""
    try:
        log('info', 'Tool called: get_webhook_public_key')
        r = _session.get(f"{BASE_URL}/webhook/public-keys", headers={'Authorization': f'Bearer {get_token()}'}, timeout=REQUEST_TIMEOUT)
        r.raise_for_status()
        return json.dumps(r.json(), indent=2)
    except Exception as e:
        return _format_error('get_webhook_public_key', e)

if __name__ == "__main__":
    mcp.run()
