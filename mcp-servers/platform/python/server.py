import os
import json
import re
import requests
from typing import Annotated
from pydantic import Field
from urllib.parse import quote, quote_plus
from urllib3.util.retry import Retry
from requests.adapters import HTTPAdapter
from dotenv import load_dotenv
from mcp.server.mcpserver import MCPServer
from mcp.server.caching import CacheHint
# Raised (not returned) so the result carries isError: true, as the Node servers' do; the SDK
# passes a ToolError's message through, where any other exception becomes 'Error executing tool'.
from mcp.server.mcpserver.exceptions import ToolError

_dotenv_path = os.environ.get('PIXELZ_DOTENV_PATH') or os.path.abspath(os.path.join(os.path.dirname(__file__), '../../../.env'))
load_dotenv(_dotenv_path)

# The tool list is static and carries no per-account data, so clients can cache it and
# shared intermediaries may too (SEP-2549). Mirrors the Node server's cacheHints.
mcp = MCPServer(
    "pixelz-platform-mcp-python",
    cache_hints={"tools/list": CacheHint(ttl_ms=3_600_000, scope="public")},
)
BASE_URL = 'https://api.pixelz.com/REST.svc/JSON'
REQUEST_TIMEOUT = 90

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

def get_auth():
    email = os.getenv('PIXELZ_PLATFORM_EMAIL')
    api_key = os.getenv('PIXELZ_PLATFORM_API_KEY')
    if not email or not api_key:
        raise ValueError("[AUTH_ERROR] Missing PIXELZ_PLATFORM_EMAIL or PIXELZ_PLATFORM_API_KEY in .env")
    return {'contactEmail': email, 'contactAPIkey': api_key}

def _checked(response):
    """Raise on a non-2xx status, then decode JSON.

    check_api_error() only inspects the body's ErrorCode, so without this an HTTP 4xx/5xx
    whose body carries no ErrorCode was handed to the agent as a successful result — and
    _format_error's HTTPError branch could never fire for a tool call.
    """
    response.raise_for_status()
    return response.json()

def check_api_error(data):
    if isinstance(data, dict):
        code = data.get('ErrorCode')
        if code is not None and code != 'NoError' and code != 0:
            raise Exception(f"[API_ERROR] {code}: {data.get('Message', '')}")

def ensure_url(input_path):
    if not input_path: return None
    if input_path.startswith(('http://', 'https://')): return input_path
    if not os.path.exists(input_path): raise Exception(f"Local file not found: {input_path}")
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
    # Documented shape is {"ErrorCode": "NoError", "Message": "", "PostingUrls": [...]}. ErrorCode
    # is always present, so only a value other than NoError is a failure.
    code = body.get('ErrorCode') if isinstance(body, dict) else None
    if code not in (None, 'NoError', 0):
        if code == 'InvalidCustomerInformation':
            raise Exception(f"[AUTH_ERROR] Platform API rejected the credentials: {body.get('Message', '')}")
        raise Exception(
            f"[PRESIGN_UNAVAILABLE] {code}: {body.get('Message') or 'Presigned URL request failed'}. "
            "The account may not be enabled for direct file uploads. "
            "Provide a publicly accessible image URL instead of a local file path."
        )
    # A bare list is still accepted, as this code originally assumed that shape.
    posting_urls = body.get('PostingUrls') if isinstance(body, dict) else body
    if not isinstance(posting_urls, list) or not posting_urls:
        raise Exception("RequestPresignUrls returned an unexpected response.")
    target = posting_urls[0]
    log('info', 'Uploading file to S3', {'fileName': file_name, 'size': file_size})
    with open(resolved, 'rb') as f:
        r_put = _session.put(target['UploadUrl'], data=f, headers={'Content-Type': 'application/octet-stream'}, timeout=REQUEST_TIMEOUT)
        # Without this the DownloadUrl is returned for an object that was never stored,
        # and the retouching job is created against a missing file.
        r_put.raise_for_status()
    return target['DownloadUrl']

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
    elif isinstance(e, ValueError) and not str(e).startswith('[AUTH_ERROR]'):
        msg = f"[VALIDATION_ERROR] {e}"
    else:
        msg = str(e)
    msg = redact_secrets(msg)
    log('error', f'{tool_name} failed', {'error': msg})
    # No "Error: " prefix: the SDK already reports a ToolError as "Error executing tool <name>: ...".
    return msg

STATUS_ALIASES = {
    'new': '10', 'in production': '60', 'production finished': '70', 'delivered': '80'
}

def _resolve_status(value):
    if value is None:
        return value
    lower = str(value).lower()
    return STATUS_ALIASES.get(lower, value)

def _validate_required_str(value, name):
    if not value or not str(value).strip():
        raise ValueError(f"{name}: must be a non-empty string")

@mcp.tool()
def list_templates() -> str:
    """List all retouching specification templates in the Pixelz account. Call this first to discover the templateId required for upload_image."""
    try:
        log('info', 'Tool called: list_templates')
        data = _checked(_session.get(f"{BASE_URL}/Templates", params=get_auth(), timeout=REQUEST_TIMEOUT))
        check_api_error(data)
        return json.dumps(data, indent=2)
    except Exception as e:
        raise ToolError(_format_error('list_templates', e)) from e

@mcp.tool()
def get_template_detail(templateId: Annotated[str, Field(description="Numeric template ID from list_templates")]) -> str:
    """Get the full technical configuration of a specific Pixelz template, including output format, background type, margins, alignment, and price per image."""
    try:
        _validate_required_str(templateId, 'templateId')
        validate_id(templateId, 'templateId')
        log('info', 'Tool called: get_template_detail', {'templateId': templateId})
        data = _checked(_session.get(f"{BASE_URL}/Template/{templateId}", params=get_auth(), timeout=REQUEST_TIMEOUT))
        check_api_error(data)
        return json.dumps(data, indent=2)
    except Exception as e:
        raise ToolError(_format_error('get_template_detail', e)) from e

@mcp.tool()
def upload_image(imagePath: Annotated[str, Field(description="Local file path or public URL of the primary image")], templateId: Annotated[str, Field(description="Numeric specification ID. Use list_templates to find the right one.")], customerImageId: str = None, productId: str = None,
                 imageCallbackURL: Annotated[str, Field(description="Webhook URL for completion notification")] = None, comment: Annotated[str, Field(description="Instructions for the retouching expert")] = None, markupImageUrl: str = None,
                 customerFolder: str = None, imageDeadlineDateTimeUTC: Annotated[str, Field(description="yyyy-MM-dd HH:mm:ss, must be at least 24h in future")] = None,
                 imageURL2: str = None, imageURL3: str = None, imageURL4: str = None, imageURL5: str = None,
                 colorReferenceFileURL: str = None, swatchImageURL: str = None, swatchColorCode: Annotated[str, Field(description="Hex color like #FFFFFF")] = None,
                 markerX: int = None, markerY: int = None, outputFileName: str = None,
                 customerImageColorID: str = None, colorwayIds: Annotated[list[int], Field(description="Array of color library IDs from add_color_library")] = None) -> str:
    """Submit an image for professional manual retouching. Accepts a local file path or public URL — local files are uploaded to S3 automatically. Returns an ImageTicket GUID; use get_image_status to track progress."""
    try:
        _validate_required_str(imagePath, 'imagePath')
        _validate_required_str(templateId, 'templateId')
        log('info', 'Tool called: upload_image', {'templateId': templateId})
        url = ensure_url(imagePath)
        payload = {k: v for k, v in {
            **get_auth(), 'imageURL': url, 'templateId': templateId,
            'customerImageId': customerImageId, 'productId': productId,
            'imageCallbackURL': imageCallbackURL, 'comment': comment,
            'markupImageUrl': markupImageUrl, 'customerFolder': customerFolder,
            'imageDeadlineDateTimeUTC': imageDeadlineDateTimeUTC,
            'imageURL2': imageURL2, 'imageURL3': imageURL3,
            'imageURL4': imageURL4, 'imageURL5': imageURL5,
            'colorReferenceFileURL': colorReferenceFileURL,
            'swatchImageURL': swatchImageURL, 'swatchColorCode': swatchColorCode,
            'markerX': markerX, 'markerY': markerY,
            'outputFileName': outputFileName, 'customerImageColorID': customerImageColorID,
            'colorwayIds': colorwayIds
        }.items() if v is not None}
        data = _checked(_session.post(f"{BASE_URL}/Image", json=payload, timeout=REQUEST_TIMEOUT))
        check_api_error(data)
        return json.dumps(data, indent=2)
    except Exception as e:
        raise ToolError(_format_error('upload_image', e)) from e

@mcp.tool()
def white_glove_service(imagePath: Annotated[str, Field(description="Local file path or public URL")], comment: Annotated[str, Field(description="Instructions or context for the specialist")] = None, markupImageUrl: str = None,
                        imageURL2: str = None, imageURL3: str = None, imageURL4: str = None, imageURL5: str = None,
                        colorReferenceFileURL: str = None,
                        customerImageId: str = None, productId: str = None,
                        customerFolder: str = None, imageCallbackURL: str = None) -> str:
    """Submit an image when you don't know which template to use. A Pixelz specialist manually selects the best settings. Accepts local file path or public URL."""
    try:
        _validate_required_str(imagePath, 'imagePath')
        log('info', 'Tool called: white_glove_service')
        url = ensure_url(imagePath)
        payload = {k: v for k, v in {
            **get_auth(), 'imageURL': url, 'comment': comment,
            'markupImageUrl': markupImageUrl, 'imageURL2': imageURL2, 'imageURL3': imageURL3,
            'imageURL4': imageURL4, 'imageURL5': imageURL5, 'colorReferenceFileURL': colorReferenceFileURL,
            'customerImageId': customerImageId, 'productId': productId, 'customerFolder': customerFolder,
            'imageCallbackURL': imageCallbackURL
        }.items() if v is not None}
        data = _checked(_session.post(f"{BASE_URL}/WhiteGloveService", json=payload, timeout=REQUEST_TIMEOUT))
        check_api_error(data)
        return json.dumps(data, indent=2)
    except Exception as e:
        raise ToolError(_format_error('white_glove_service', e)) from e

@mcp.tool()
def stack_image(imagePath: Annotated[str, Field(description="Local file path or public URL")], templateId: str = None, customerImageId: str = None,
                productId: Annotated[str, Field(description="Must be identical across all parts of the same stack")] = None, customerFolder: str = None, imageCallbackURL: str = None,
                imageDeadlineDateTimeUTC: str = None) -> str:
    """Submit one part of a multi-image stack. All parts must share the same productId and be submitted within 5 minutes of each other. Accepts local file path or public URL."""
    try:
        _validate_required_str(imagePath, 'imagePath')
        log('info', 'Tool called: stack_image')
        url = ensure_url(imagePath)
        payload = {k: v for k, v in {
            **get_auth(), 'imageURL': url, 'templateId': templateId,
            'customerImageId': customerImageId, 'productId': productId,
            'customerFolder': customerFolder, 'imageCallbackURL': imageCallbackURL,
            'imageDeadlineDateTimeUTC': imageDeadlineDateTimeUTC
        }.items() if v is not None}
        data = _checked(_session.post(f"{BASE_URL}/StackImage", json=payload, timeout=REQUEST_TIMEOUT))
        check_api_error(data)
        return json.dumps(data, indent=2)
    except Exception as e:
        raise ToolError(_format_error('stack_image', e)) from e

@mcp.tool()
def get_image_status(imageTicket: Annotated[str, Field(description="GUID returned by upload_image or white_glove_service")], customerImageId: str = None) -> str:
    """Get the processing status of an uploaded image. Status codes: 10=New, 60=In Production, 70=Production Finished (QC), 80=Delivered. When status is 80 the FinalImagesURL is ready for download."""
    try:
        _validate_required_str(imageTicket, 'imageTicket')
        validate_id(imageTicket, 'imageTicket')
        log('info', 'Tool called: get_image_status', {'imageTicket': imageTicket})
        params = {**get_auth(), 'customerImageId': customerImageId}
        data = _checked(_session.get(f"{BASE_URL}/Image/{imageTicket}", params={k: v for k, v in params.items() if v is not None}, timeout=REQUEST_TIMEOUT))
        check_api_error(data)
        return json.dumps(data, indent=2)
    except Exception as e:
        raise ToolError(_format_error('get_image_status', e)) from e

@mcp.tool()
def list_images(imageStatus: Annotated[str, Field(description="Filter by status code or name (10/new, 60/in production, 70/production finished, 80/delivered)")] = None, excludeImageStatus: Annotated[str, Field(description="Exclude by status code or name")] = None, productId: str = None,
                fromDate: Annotated[str, Field(description="YYYY-MM-DD")] = None, toDate: Annotated[str, Field(description="YYYY-MM-DD")] = None, page: int = 1,
                imagesPerPage: Annotated[int, Field(description="Max 100")] = 10, sortBy: str = None, isDescending: str = None) -> str:
    """Search and list images in the account. Status accepts codes or names: 10/new, 60/in production, 70/production finished, 80/delivered. Returns ticket IDs, statuses, and dates."""
    try:
        log('info', 'Tool called: list_images')
        imageStatus = _resolve_status(imageStatus)
        excludeImageStatus = _resolve_status(excludeImageStatus)
        params = {k: v for k, v in {
            **get_auth(), 'imageStatus': imageStatus, 'excludeImageStatus': excludeImageStatus,
            'productId': productId, 'fromDate': fromDate, 'toDate': toDate,
            'page': page, 'imagesPerPage': imagesPerPage, 'sortBy': sortBy, 'isDescending': isDescending
        }.items() if v is not None}
        data = _checked(_session.get(f"{BASE_URL}/Images", params=params, timeout=REQUEST_TIMEOUT))
        check_api_error(data)
        return json.dumps(data, indent=2)
    except Exception as e:
        raise ToolError(_format_error('list_images', e)) from e

@mcp.tool()
def count_images(imageStatus: Annotated[str, Field(description="Filter by status code or name (10/new, 60/in production, 70/production finished, 80/delivered)")] = None, fromDate: Annotated[str, Field(description="YYYY-MM-DD")] = None, toDate: Annotated[str, Field(description="YYYY-MM-DD")] = None) -> str:
    """Get a count of images matching the given filters. Faster than list_images when you only need a total number. Status accepts codes or names: 10/new, 60/in production, 70/production finished, 80/delivered."""
    try:
        log('info', 'Tool called: count_images')
        imageStatus = _resolve_status(imageStatus)
        params = {k: v for k, v in {**get_auth(), 'imageStatus': imageStatus, 'fromDate': fromDate, 'toDate': toDate}.items() if v is not None}
        data = _checked(_session.get(f"{BASE_URL}/Images/Count", params=params, timeout=REQUEST_TIMEOUT))
        check_api_error(data)
        return json.dumps(data, indent=2)
    except Exception as e:
        raise ToolError(_format_error('count_images', e)) from e

@mcp.tool()
def list_product_ids(page: int = 1, perPage: int = 10) -> str:
    """List product IDs with completion statistics (TodoCount vs DoneCount). Useful for tracking whether an entire product batch has been fully retouched."""
    try:
        log('info', 'Tool called: list_product_ids')
        data = _checked(_session.get(f"{BASE_URL}/ProductIds", params={**get_auth(), 'page': page, 'productIdsPerPage': perPage}, timeout=REQUEST_TIMEOUT))
        check_api_error(data)
        return json.dumps(data, indent=2)
    except Exception as e:
        raise ToolError(_format_error('list_product_ids', e)) from e

@mcp.tool()
def delete_image(imageTicket: str, customerImageId: str = None) -> str:
    """Cancel and delete an image processing request. Only possible before the image enters production (status < 60). Confirm the ticket with the user before calling."""
    try:
        _validate_required_str(imageTicket, 'imageTicket')
        validate_id(imageTicket, 'imageTicket')
        log('info', 'Tool called: delete_image', {'imageTicket': imageTicket})
        # customerImageId is what the API needs to delete a 'nonticket' image.
        payload = {**get_auth(), **({'customerImageId': customerImageId} if customerImageId else {})}
        data = _checked(_session.delete(f"{BASE_URL}/Image/{imageTicket}", json=payload, timeout=REQUEST_TIMEOUT))
        check_api_error(data)
        return json.dumps(data, indent=2)
    except Exception as e:
        raise ToolError(_format_error('delete_image', e)) from e

@mcp.tool()
def reject_image(imageTicket: str, comment: Annotated[str, Field(description="Clear description of what needs fixing \u2014 sent directly to the retouching expert")], markupImageUrl: Annotated[str, Field(description="URL to an annotated image showing exactly what needs correcting")] = None, customerImageId: str = None) -> str:
    """Request a correction (redo) for a delivered image. Only valid when status is 80 (Delivered). The image re-enters the production queue at no extra charge. comment is sent directly to the retouching expert."""
    try:
        _validate_required_str(imageTicket, 'imageTicket')
        _validate_required_str(comment, 'comment')
        validate_id(imageTicket, 'imageTicket')
        log('info', 'Tool called: reject_image', {'imageTicket': imageTicket})
        payload = {k: v for k, v in {**get_auth(), 'comment': comment, 'markupImageUrl': markupImageUrl, 'customerImageId': customerImageId}.items() if v is not None}
        data = _checked(_session.put(f"{BASE_URL}/Image/Reject/{imageTicket}", json=payload, timeout=REQUEST_TIMEOUT))
        check_api_error(data)
        return json.dumps(data, indent=2)
    except Exception as e:
        raise ToolError(_format_error('reject_image', e)) from e

@mcp.tool()
def get_contact() -> str:
    """Retrieve account profile including company details and current credit balance (ContactAccountBalance and Currency)."""
    try:
        log('info', 'Tool called: get_contact')
        data = _checked(_session.get(f"{BASE_URL}/Contact", params=get_auth(), timeout=REQUEST_TIMEOUT))
        check_api_error(data)
        return json.dumps(data, indent=2)
    except Exception as e:
        raise ToolError(_format_error('get_contact', e)) from e

@mcp.tool()
def get_invoices(fromDate: Annotated[str, Field(description="YYYY-MM-DD")] = None, toDate: Annotated[str, Field(description="YYYY-MM-DD")] = None, page: int = 1, returnUrl: Annotated[str, Field(description="Redirect URL after payment completion")] = None) -> str:
    """Retrieve billing statements. Returns invoice amounts, dates, and payment URLs. returnUrl is a redirect URL after payment completion."""
    try:
        log('info', 'Tool called: get_invoices')
        params = {k: v for k, v in {**get_auth(), 'fromDate': fromDate, 'toDate': toDate, 'page': page, 'returnUrl': returnUrl}.items() if v is not None}
        data = _checked(_session.get(f"{BASE_URL}/Invoices", params=params, timeout=REQUEST_TIMEOUT))
        check_api_error(data)
        return json.dumps(data, indent=2)
    except Exception as e:
        raise ToolError(_format_error('get_invoices', e)) from e

@mcp.tool()
def add_color_library(imagesPath: Annotated[list[str], Field(description="Array of local file paths or public URLs of color swatch images")]) -> str:
    """Register color reference images (swatches) for use with color matching. Returns colorwayIds that can be passed to upload_image. Accepts local file paths or public URLs — local files are uploaded to S3 automatically."""
    try:
        log('info', 'Tool called: add_color_library', {'count': len(imagesPath)})
        if not imagesPath:
            raise ValueError("imagesPath must contain at least one image path or URL")
        resolved_urls = [ensure_url(p) for p in imagesPath]
        payload = {**get_auth(), 'imagesUrl': resolved_urls}
        data = _checked(_session.post(f"{BASE_URL}/AddColorLibrary", json=payload, timeout=REQUEST_TIMEOUT))
        check_api_error(data)
        return json.dumps(data, indent=2)
    except Exception as e:
        raise ToolError(_format_error('add_color_library', e)) from e

if __name__ == "__main__":
    mcp.run()
