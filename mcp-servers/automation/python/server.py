import os
import sys
import json
import re
import time
import mimetypes
import requests
from dotenv import load_dotenv
from mcp.server.fastmcp import FastMCP

_dotenv_path = os.environ.get('PIXELZ_DOTENV_PATH') or os.path.abspath(os.path.join(os.path.dirname(__file__), '../../../.env'))
load_dotenv(_dotenv_path)

mcp = FastMCP("pixelz-automation-mcp")
AUTH_URL = 'https://id.pixelz.com/realms/pixelz-automations/protocol/openid-connect/token'
BASE_URL = 'https://automation-api.pixelz.com/v1'
REQUEST_TIMEOUT = 90
MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024  # 2 GB

_log_file = os.getenv('PIXELZ_LOG_FILE')

def redact_secrets(text):
    """Replace known credential values and bearer tokens in text with <REDACTED>."""
    s = str(text)
    for key in ('PIXELZ_AUTOMATION_CLIENT_ID', 'PIXELZ_AUTOMATION_CLIENT_SECRET'):
        val = os.getenv(key)
        if val:
            s = s.replace(val, '<REDACTED>')
    s = re.sub(r'eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', '<REDACTED>', s)
    return s

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
        raise ValueError("[AUTH_ERROR] Missing PIXELZ_AUTOMATION_CLIENT_ID or PIXELZ_AUTOMATION_CLIENT_SECRET in .env")
    log('info', 'Requesting new OAuth token')
    r = requests.post(AUTH_URL, data={'grant_type': 'client_credentials', 'client_id': cid, 'client_secret': sec}, timeout=REQUEST_TIMEOUT)
    r.raise_for_status()
    data = r.json()
    _token_cache['token'] = data['access_token']
    _token_cache['expires_at'] = time.time() + (data.get('expires_in', 3600) - 60)
    return _token_cache['token']

def ensure_url_or_id(input_path, token):
    if not input_path: return None
    if input_path.startswith(('http://', 'https://')): return input_path
    if not os.path.exists(input_path): raise Exception(f"Local file not found: {input_path}")
    file_size = os.path.getsize(input_path)
    if file_size > MAX_FILE_SIZE:
        raise Exception(f"File too large ({file_size / (1024**3):.2f} GB). Maximum allowed size is 2 GB.")
    headers = {'Authorization': f'Bearer {token}'}
    log('info', 'Requesting upload URL', {'fileName': os.path.basename(input_path)})
    r = requests.post(f"{BASE_URL}/files/request-upload-url", json={'fileName': os.path.basename(input_path)}, headers=headers, timeout=REQUEST_TIMEOUT)
    r.raise_for_status()
    upload_url = r.json()['url']
    content_type = mimetypes.guess_type(input_path)[0] or 'application/octet-stream'
    log('info', 'Uploading file', {'fileName': os.path.basename(input_path), 'size': file_size})
    with open(input_path, 'rb') as f:
        requests.put(upload_url, data=f, headers={'Content-Type': content_type}, timeout=REQUEST_TIMEOUT).raise_for_status()
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
    elif isinstance(e, ValueError):
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
def remove_background(imagePath: str, backgroundColor: str = None, transparentBackground: bool = True,
                      featherWidth: float = None, trimapUrl: str = None, callbackUrl: str = None,
                      sync: bool = False) -> str:
    """AI-powered background removal. Default: async — returns job_id immediately; call get_job_status every 30-60 seconds. featherWidth softens edges (0-1=sharp, >1=soft). Pass trimapUrl from create_trimap for complex edges. Set sync=True only if the user explicitly requests it (risk of timeout)."""
    try:
        _validate_required_str(imagePath, 'imagePath')
        _validate_hex_color(backgroundColor, 'backgroundColor')
        if featherWidth is not None and featherWidth < 0:
            raise ValueError("featherWidth: must be >= 0")
        log('info', 'Tool called: remove_background')
        token = get_token()
        url = ensure_url_or_id(imagePath, token)
        payload = {k: v for k, v in {
            'image_url': url, 'background_color': backgroundColor,
            'transparent_background': transparentBackground,
            'feather_width': featherWidth, 'trimap_url': trimapUrl, 'callback_url': callbackUrl
        }.items() if v is not None}
        r = requests.post(f"{BASE_URL}/images/remove-background", json=payload, headers=api_headers(token, sync), timeout=REQUEST_TIMEOUT)
        r.raise_for_status()
        return json.dumps(r.json(), indent=2)
    except Exception as e:
        return _format_error('remove_background', e)

@mcp.tool()
def color_matching(imagePath: str, colorMarkers: list, callbackUrl: str = None, sync: bool = False) -> str:
    """AI-powered color correction. Default: async — returns job_id immediately; call get_job_status every 30-60 seconds. colorMarkers is an array of objects with x_coordinate, y_coordinate, and either swatch_color_code (hex) or swatch_image. Set sync=True only if the user explicitly requests it."""
    try:
        _validate_required_str(imagePath, 'imagePath')
        if not colorMarkers or not isinstance(colorMarkers, list) or len(colorMarkers) == 0:
            raise ValueError("colorMarkers: must be a non-empty array")
        log('info', 'Tool called: color_matching')
        token = get_token()
        url = ensure_url_or_id(imagePath, token)
        payload = {k: v for k, v in {'image_url': url, 'color_markers': colorMarkers, 'callback_url': callbackUrl}.items() if v is not None}
        r = requests.post(f"{BASE_URL}/images/color-matching", json=payload, headers=api_headers(token, sync), timeout=REQUEST_TIMEOUT)
        r.raise_for_status()
        return json.dumps(r.json(), indent=2)
    except Exception as e:
        return _format_error('color_matching', e)

@mcp.tool()
def create_mask(imagePath: str, featherWidth: float = None, trimapUrl: str = None, callbackUrl: str = None,
                sync: bool = False) -> str:
    """Generate a greyscale silhouette mask (white=subject, black=background). Default: async — returns job_id immediately; call get_job_status every 30-60 seconds. Set sync=True only if the user explicitly requests it."""
    try:
        _validate_required_str(imagePath, 'imagePath')
        if featherWidth is not None and featherWidth < 0:
            raise ValueError("featherWidth: must be >= 0")
        log('info', 'Tool called: create_mask')
        token = get_token()
        url = ensure_url_or_id(imagePath, token)
        payload = {k: v for k, v in {'image_url': url, 'feather_width': featherWidth, 'trimap_url': trimapUrl, 'callback_url': callbackUrl}.items() if v is not None}
        r = requests.post(f"{BASE_URL}/images/create-mask", json=payload, headers=api_headers(token, sync), timeout=REQUEST_TIMEOUT)
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
        r = requests.post(f"{BASE_URL}/images/create-trimap", json=payload, headers=api_headers(token, sync), timeout=REQUEST_TIMEOUT)
        r.raise_for_status()
        return json.dumps(r.json(), indent=2)
    except Exception as e:
        return _format_error('create_trimap', e)

@mcp.tool()
def model_crop(imagePath: str, topCropLocation: str = None, bottomCropLocation: str = None,
               callbackUrl: str = None, sync: bool = False) -> str:
    """Crop a model photograph using anatomical landmarks. Default: async — returns job_id immediately; call get_job_status every 30-60 seconds. Valid locations: eye_higher, below_eye, btw_eye_and_nose, below_nose, between_nose_and_mouth, below_mouth, below_chin, chest, at_elbow_higher, at_elbow_lower, waist, below_buttock, main_body_axis, mid_thigh, above_knee, at_knee, below_knee. Set sync=True only if the user explicitly requests it."""
    try:
        _validate_required_str(imagePath, 'imagePath')
        _validate_crop_location(topCropLocation, 'topCropLocation')
        _validate_crop_location(bottomCropLocation, 'bottomCropLocation')
        log('info', 'Tool called: model_crop')
        token = get_token()
        url = ensure_url_or_id(imagePath, token)
        payload = {k: v for k, v in {'image_url': url, 'top_crop_location': topCropLocation, 'bottom_crop_location': bottomCropLocation, 'callback_url': callbackUrl}.items() if v is not None}
        r = requests.post(f"{BASE_URL}/images/model-crop", json=payload, headers=api_headers(token, sync), timeout=REQUEST_TIMEOUT)
        r.raise_for_status()
        return json.dumps(r.json(), indent=2)
    except Exception as e:
        return _format_error('model_crop', e)

@mcp.tool()
def get_job_status(jobId: str) -> str:
    """Poll the status of any async Automation job. Call every 30-60 seconds. PENDING/PROCESSING = still working; FINISHED = result_image_url is ready; FAILED = report the error and ask whether to resubmit."""
    try:
        validate_id(jobId, 'jobId')
        log('info', 'Tool called: get_job_status', {'jobId': jobId})
        r = requests.get(f"{BASE_URL}/images/jobs/{jobId}/status", headers={'Authorization': f'Bearer {get_token()}'}, timeout=REQUEST_TIMEOUT)
        r.raise_for_status()
        return json.dumps(r.json(), indent=2)
    except Exception as e:
        return _format_error('get_job_status', e)

@mcp.tool()
def get_webhook_public_key() -> str:
    """Retrieve the ECDSA public key used to verify Pixelz Automation webhook payload signatures. Store this key in your application to validate incoming webhook requests."""
    try:
        log('info', 'Tool called: get_webhook_public_key')
        r = requests.get(f"{BASE_URL}/webhook/public-keys", headers={'Authorization': f'Bearer {get_token()}'}, timeout=REQUEST_TIMEOUT)
        r.raise_for_status()
        return json.dumps(r.json(), indent=2)
    except Exception as e:
        return _format_error('get_webhook_public_key', e)

if __name__ == "__main__":
    mcp.run()
