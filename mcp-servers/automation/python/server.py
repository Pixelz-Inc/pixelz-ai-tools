import os
import sys
import json
import re
import time
import threading
import requests
from typing import Annotated
from pydantic import Field
from mcp.server.mcpserver import MCPServer
from mcp.server.caching import CacheHint
from mcp.types import ToolAnnotations
# Raised (not returned) so the result carries isError: true, as the Node servers' do; the SDK
# passes a ToolError's message through, where any other exception becomes 'Error executing tool'.
from mcp.server.mcpserver.exceptions import ToolError

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '../../../shared/python')))
import pixelz_common
from pixelz_common import (
    validate_id, is_read_timeout as _is_read_timeout, is_url, HEX_COLOR, CROP_LOCATIONS, UPLOAD_UNAVAILABLE,
    validate_required_str as _validate_required_str, validate_hex_color as _validate_hex_color)

pixelz_common.load_env(__file__)

def _read_repo_version():
    return pixelz_common.read_repo_version(__file__)

# The tool list is static and carries no per-account data, so clients can cache it and
# shared intermediaries may too (SEP-2549). Mirrors the Node server's cacheHints.
mcp = MCPServer(
    "pixelz-automation-mcp",
    version=_read_repo_version(),
    cache_hints={"tools/list": CacheHint(ttl_ms=3_600_000, scope="public")},
)

# MCP tool annotations (hints for clients deciding whether to ask the user before a call).
READ_ONLY = ToolAnnotations(readOnlyHint=True, openWorldHint=True)
CREATES_JOB = ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False, openWorldHint=True)
AUTH_URL = 'https://id.pixelz.com/realms/pixelz-automations/protocol/openid-connect/token'
BASE_URL = 'https://automation-api.pixelz.com/v1'
REQUEST_TIMEOUT = 90

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
    if is_url(input_path): return input_path
    resolved, file_size = pixelz_common.resolve_local_file(input_path, pixelz_common.AUTOMATION_UPLOAD_EXTENSIONS)
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
    # Not mimetypes.guess_type: that reads the OS registry on Windows and differs from Node.
    content_type = pixelz_common.AUTOMATION_MIME_TYPES.get(os.path.splitext(resolved)[1].lower(), 'application/octet-stream')
    log('info', 'Uploading file', {'fileName': file_name, 'size': file_size})
    with open(resolved, 'rb') as f:
        _session.put(upload_url, data=f, headers={'Content-Type': content_type}, timeout=REQUEST_TIMEOUT).raise_for_status()
    return upload_url

def api_headers(token, sync=False):
    h = {'Authorization': f'Bearer {token}'}
    if not sync:
        h['Respond-Mode'] = 'async'
    return h

def _format_error(tool_name, e):
    """Format errors with categorized prefixes matching Node.js MCP parity."""
    if isinstance(e, requests.exceptions.Timeout):
        msg = f"[TIMEOUT] Request timed out after {REQUEST_TIMEOUT} seconds"
    elif isinstance(e, requests.exceptions.ConnectionError):
        msg = (f"[TIMEOUT] Request timed out after {REQUEST_TIMEOUT} seconds" if _is_read_timeout(e)
               else f"[NETWORK_ERROR] {e}")
    elif isinstance(e, requests.exceptions.HTTPError) and e.response is not None:
        status = e.response.status_code
        try:
            body = e.response.json()
            msg = f"[HTTP_{status}] {json.dumps(body)}"
        except Exception:
            msg = f"[HTTP_{status}] {e.response.text}"
    elif isinstance(e, requests.exceptions.JSONDecodeError):
        # A 2xx that is not JSON is a proxy or login page, not a bad argument.
        msg = f"[API_ERROR] Expected a JSON response: {e}"
    elif isinstance(e, ValueError) and not re.match(r'\[[A-Z0-9_]+\]', str(e)):
        msg = f"[VALIDATION_ERROR] {e}"
    else:
        msg = str(e)
    msg = redact_secrets(msg)
    log('error', f'{tool_name} failed', {'error': msg})
    # No "Error: " prefix: the SDK already reports a ToolError as "Error executing tool <name>: ...".
    return msg

def _validate_crop_location(value, name):
    if value is not None and value not in CROP_LOCATIONS:
        raise ValueError(f"{name}: must be one of {', '.join(CROP_LOCATIONS)}")

def _is_int(value):
    # JSON 100.0 is an integer to the API (and to Node's z.number().int()); bool is not a number here.
    return not isinstance(value, bool) and (isinstance(value, int) or (isinstance(value, float) and value.is_integer()))

def _validate_color_markers(markers):
    """Same rules as the Node ColorMarkerSchema (OpenAPI ColorMarker/SwatchImage)."""
    if not isinstance(markers, list) or not markers:
        raise ValueError("colorMarkers: must be a non-empty array")
    marker_keys = {'x_coordinate', 'y_coordinate', 'swatch_color_code', 'swatch_image'}
    swatch_keys = {'swatch_image_url', 'x_coordinate', 'y_coordinate'}
    for i, m in enumerate(markers):
        at = f"colorMarkers.{i}"
        if not isinstance(m, dict):
            raise ValueError(f"{at}: must be an object")
        for key in m:
            if key not in marker_keys:
                raise ValueError(f'{at}: unrecognized key "{key}"')
        for key in ('x_coordinate', 'y_coordinate'):
            if not _is_int(m.get(key)):
                raise ValueError(f"{at}.{key}: must be an integer")
        code, swatch = m.get('swatch_color_code'), m.get('swatch_image')
        if (code is not None) == (swatch is not None):
            raise ValueError(f"{at}: exactly one of swatch_color_code or swatch_image is required")
        if code is not None and (not isinstance(code, str) or not HEX_COLOR.fullmatch(code)):
            raise ValueError(f"{at}.swatch_color_code: must be a hex color like #FFFFFF")
        if swatch is not None:
            if not isinstance(swatch, dict):
                raise ValueError(f"{at}.swatch_image: must be an object")
            for key in swatch:
                if key not in swatch_keys:
                    raise ValueError(f'{at}.swatch_image: unrecognized key "{key}"')
            if not isinstance(swatch.get('swatch_image_url'), str) or not swatch['swatch_image_url']:
                raise ValueError(f"{at}.swatch_image.swatch_image_url: must be a non-empty string")
            for key in ('x_coordinate', 'y_coordinate'):
                if not _is_int(swatch.get(key)):
                    raise ValueError(f"{at}.swatch_image.{key}: must be an integer")

# Mirrors the Node server's COLOR_MARKER_JSON_SCHEMA; _validate_color_markers enforces it.
COLOR_MARKER_JSON_SCHEMA = {
    "type": "object",
    "properties": {
        "x_coordinate": {"type": "integer", "description": "Horizontal pixel position of the colour sample in the main image (centre of a 30x30 block; avoid shadows/highlights)."},
        "y_coordinate": {"type": "integer", "description": "Vertical pixel position of the colour sample in the main image."},
        "swatch_color_code": {"type": "string", "pattern": "^#[0-9A-Fa-f]{6}$", "description": "Target colour as #RRGGBB. Mutually exclusive with swatch_image."},
        "swatch_image": {
            "type": "object",
            "description": "Reference swatch image. Mutually exclusive with swatch_color_code.",
            "properties": {
                "swatch_image_url": {"type": "string", "description": "Public URL of the swatch image."},
                "x_coordinate": {"type": "integer", "description": "Horizontal pixel position of the colour sample in the swatch image."},
                "y_coordinate": {"type": "integer", "description": "Vertical pixel position of the colour sample in the swatch image."},
            },
            "required": ["swatch_image_url", "x_coordinate", "y_coordinate"],
            "additionalProperties": False,
        },
    },
    "required": ["x_coordinate", "y_coordinate"],
    "additionalProperties": False,
}

# json_schema_extra advertises the enum without pydantic rejecting first, so the check in the tool keeps the [VALIDATION_ERROR] contract.
CropLocation = Annotated[str, Field(json_schema_extra={"enum": list(CROP_LOCATIONS)})]

@mcp.tool(annotations=CREATES_JOB)
def remove_background(imagePath: Annotated[str, Field(description="Local file path or public URL")], backgroundColor: Annotated[str, Field(description="Hex color for replacement background (e.g. #FFFFFF). Mutually exclusive with transparentBackground.")] = None, transparentBackground: Annotated[bool, Field(description="Return a transparent PNG. Defaults to true if backgroundColor is not set.")] = None,
                      featherWidth: Annotated[float, Field(description="Soften subject edges. 0\u20131 = sharp, >1 = soft.")] = None, trimapUrl: Annotated[str, Field(description="URL of a trimap for improved edge quality. Generate one first with create_trimap.")] = None, callbackUrl: Annotated[str, Field(description="Webhook URL to receive result notification.")] = None,
                      sync: Annotated[bool, Field(description="Run synchronously. Only use if user explicitly requests it \u2014 may time out on large images.")] = False) -> str:
    """AI-powered background removal. Billed: 100 tokens per job. Default: async — returns job_id immediately. Most jobs finish in 30-60 seconds; call get_job_status once to check, never in a loop. featherWidth softens edges (0-1=sharp, >1=soft). Pass trimapUrl from create_trimap for complex edges. Set sync=True only if the user explicitly requests it (risk of timeout)."""
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
        raise ToolError(_format_error('remove_background', e)) from e

@mcp.tool(annotations=CREATES_JOB)
def color_matching(imagePath: Annotated[str, Field(description="Local file path or public URL")],
                   colorMarkers: Annotated[list, Field(description="Array of marker objects. Each requires x_coordinate, y_coordinate, and exactly one of swatch_color_code (hex) or swatch_image (object with swatch_image_url, x_coordinate, y_coordinate).",
                                                       json_schema_extra={"minItems": 1, "items": COLOR_MARKER_JSON_SCHEMA})],
                   callbackUrl: str = None, sync: Annotated[bool, Field(description="Run synchronously. Only use if user explicitly requests it.")] = False) -> str:
    """AI-powered color correction. Billed: 100 tokens per job. Default: async — returns job_id immediately. Most jobs finish in 30-60 seconds; call get_job_status once to check, never in a loop. Only set sync=true if the user explicitly requests it."""
    try:
        _validate_required_str(imagePath, 'imagePath')
        _validate_color_markers(colorMarkers)
        log('info', 'Tool called: color_matching')
        token = get_token()
        url = ensure_url_or_id(imagePath, token)
        payload = {k: v for k, v in {'image_url': url, 'color_markers': colorMarkers, 'callback_url': callbackUrl}.items() if v is not None}
        r = _session.post(f"{BASE_URL}/images/color-matching", json=payload, headers=api_headers(token, sync), timeout=REQUEST_TIMEOUT)
        r.raise_for_status()
        return json.dumps(r.json(), indent=2)
    except Exception as e:
        raise ToolError(_format_error('color_matching', e)) from e

@mcp.tool(annotations=CREATES_JOB)
def create_mask(imagePath: Annotated[str, Field(description="Local file path or public URL")], featherWidth: Annotated[float, Field(description="Soften mask edges. 0\u20131 = sharp, >1 = soft.")] = None, trimapUrl: Annotated[str, Field(description="URL of a trimap for improved accuracy on complex edges.")] = None, callbackUrl: str = None,
                sync: Annotated[bool, Field(description="Run synchronously. Only use if user explicitly requests it.")] = False) -> str:
    """Generate a greyscale silhouette mask (white=subject, black=background). Billed: 100 tokens per job. Default: async — returns job_id immediately. Most jobs finish in 30-60 seconds; call get_job_status once to check, never in a loop. Set sync=True only if the user explicitly requests it."""
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
        raise ToolError(_format_error('create_mask', e)) from e

@mcp.tool(annotations=CREATES_JOB)
def create_trimap(imagePath: Annotated[str, Field(description="Local file path or public URL")], callbackUrl: str = None, sync: Annotated[bool, Field(description="Run synchronously. Only use if user explicitly requests it.")] = False) -> str:
    """Generate a trimap for complex subjects (hair, fur, transparent edges). Billed: 50 tokens per job. Default: async — returns job_id. Pass result trimapUrl to remove_background or create_mask for higher quality edges. Set sync=True only if the user explicitly requests it."""
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
        raise ToolError(_format_error('create_trimap', e)) from e

@mcp.tool(annotations=CREATES_JOB)
def model_crop(imagePath: Annotated[str, Field(description="Local file path or public URL")], topCropLocation: CropLocation = None, bottomCropLocation: CropLocation = None,
               callbackUrl: str = None, sync: Annotated[bool, Field(description="Run synchronously. Only use if user explicitly requests it.")] = False) -> str:
    """Crop a model photograph using anatomical landmarks. At least one of topCropLocation / bottomCropLocation is required. Billed: 10 tokens per job. Default: async — returns job_id immediately. Most jobs finish in 30-60 seconds; call get_job_status once to check, never in a loop. Valid locations: eye_higher, below_eye, btw_eye_and_nose, below_nose, between_nose_and_mouth, below_mouth, below_chin, chest, at_elbow_higher, at_elbow_lower, waist, below_buttock, main_body_axis, mid_thigh, above_knee, at_knee, below_knee. Set sync=True only if the user explicitly requests it."""
    try:
        _validate_required_str(imagePath, 'imagePath')
        _validate_crop_location(topCropLocation, 'topCropLocation')
        _validate_crop_location(bottomCropLocation, 'bottomCropLocation')
        # API rule: at least one of the two locations must be given.
        if not topCropLocation and not bottomCropLocation:
            raise ValueError("at least one of topCropLocation or bottomCropLocation is required")
        log('info', 'Tool called: model_crop')
        token = get_token()
        url = ensure_url_or_id(imagePath, token)
        payload = {k: v for k, v in {'image_url': url, 'top_crop_location': topCropLocation, 'bottom_crop_location': bottomCropLocation, 'callback_url': callbackUrl}.items() if v is not None}
        r = _session.post(f"{BASE_URL}/images/model-crop", json=payload, headers=api_headers(token, sync), timeout=REQUEST_TIMEOUT)
        r.raise_for_status()
        return json.dumps(r.json(), indent=2)
    except Exception as e:
        raise ToolError(_format_error('model_crop', e)) from e

@mcp.tool(annotations=READ_ONLY)
def get_job_status(jobId: str) -> str:
    """Check the status of any async Automation job (free). Most jobs finish in 30-60 seconds; large images can take several minutes. Call this once per check — never loop on it, since you cannot wait out an interval mid-turn. Read status.status_name: Created/ReadyForProcess/Processing = still working, report status and check again later; Completed or Delivered = result.result_image_url is ready; Failed = report the error to the user and ask whether to resubmit."""
    try:
        validate_id(jobId, 'jobId')
        log('info', 'Tool called: get_job_status', {'jobId': jobId})
        r = _session.get(f"{BASE_URL}/images/jobs/{jobId}/status", headers={'Authorization': f'Bearer {get_token()}'}, timeout=REQUEST_TIMEOUT)
        r.raise_for_status()
        return json.dumps(r.json(), indent=2)
    except Exception as e:
        raise ToolError(_format_error('get_job_status', e)) from e

@mcp.tool(annotations=READ_ONLY)
def get_webhook_public_key() -> str:
    """Retrieve the ECDSA public key used to verify Pixelz Automation webhook payload signatures. Store this key in your application to validate incoming webhook requests."""
    try:
        log('info', 'Tool called: get_webhook_public_key')
        r = _session.get(f"{BASE_URL}/webhook/public-keys", headers={'Authorization': f'Bearer {get_token()}'}, timeout=REQUEST_TIMEOUT)
        r.raise_for_status()
        return json.dumps(r.json(), indent=2)
    except Exception as e:
        raise ToolError(_format_error('get_webhook_public_key', e)) from e

if __name__ == "__main__":
    mcp.run()
