import os
import sys
import json
import re
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
    validate_id, is_read_timeout as _is_read_timeout, is_url, check_api_error, resolve_status as _resolve_status,
    validate_required_str as _validate_required_str, validate_hex_color as _validate_hex_color)

pixelz_common.load_env(__file__)

def _read_repo_version():
    return pixelz_common.read_repo_version(__file__)

# The tool list is static and carries no per-account data, so clients can cache it and
# shared intermediaries may too (SEP-2549). Mirrors the Node server's cacheHints.
mcp = MCPServer(
    "pixelz-platform-mcp",
    version=_read_repo_version(),
    cache_hints={"tools/list": CacheHint(ttl_ms=3_600_000, scope="public")},
)

# MCP tool annotations (hints for clients deciding whether to ask the user before a call).
READ_ONLY = ToolAnnotations(readOnlyHint=True, openWorldHint=True)
CREATES_ORDER = ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False, openWorldHint=True)
DESTRUCTIVE = ToolAnnotations(readOnlyHint=False, destructiveHint=True, openWorldHint=True)
BASE_URL = 'https://api.pixelz.com/REST.svc/JSON'
REQUEST_TIMEOUT = 90

_session = pixelz_common.make_session()

# Credentials are matched in raw AND percent-encoded form: requests echoes the whole
# request URL in ConnectionError text, and Platform auth travels as query params, so a
# key containing + / = @ appears encoded there and a literal match silently misses it.
# The param-name pass is the backstop for any encoding these variants don't anticipate.
redact_secrets = pixelz_common.make_redactor(
    ('PIXELZ_PLATFORM_API_KEY', 'PIXELZ_PLATFORM_EMAIL'), ('contactAPIkey', 'contactEmail'))
log = pixelz_common.make_logger(redact_secrets)

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

def ensure_url(input_path):
    if not input_path: return None
    if is_url(input_path): return input_path
    resolved, file_size = pixelz_common.resolve_local_file(input_path, pixelz_common.PLATFORM_UPLOAD_EXTENSIONS)
    auth = get_auth()
    file_name = os.path.basename(resolved)
    log('info', 'Requesting presigned URL', {'fileName': file_name})
    r = _session.post(f"{BASE_URL}/RequestPresignUrls", json={**auth, 'imageNames': [file_name]}, timeout=REQUEST_TIMEOUT)
    r.raise_for_status()
    target = pixelz_common.parse_platform_presign(r.json())
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
    elif isinstance(e, ValueError) and not re.match(r'\[[A-Z0-9_]+\]', str(e)):
        msg = f"[VALIDATION_ERROR] {e}"
    else:
        msg = str(e)
    msg = redact_secrets(msg)
    log('error', f'{tool_name} failed', {'error': msg})
    # No "Error: " prefix: the SDK already reports a ToolError as "Error executing tool <name>: ...".
    return msg

def _validate_one_of(value, name, allowed):
    if value is not None and value not in allowed:
        raise ValueError(f"{name}: must be one of {', '.join(allowed)}")

SORT_BY_VALUES = ("id", "date", "status")
IS_DESCENDING_VALUES = ("true", "false")

@mcp.tool(annotations=READ_ONLY)
def list_templates() -> str:
    """List all retouching specification templates in the Pixelz account. Call this first to discover the templateId required for upload_image."""
    try:
        log('info', 'Tool called: list_templates')
        data = _checked(_session.get(f"{BASE_URL}/Templates", params=get_auth(), timeout=REQUEST_TIMEOUT))
        check_api_error(data)
        return json.dumps(data, indent=2)
    except Exception as e:
        raise ToolError(_format_error('list_templates', e)) from e

@mcp.tool(annotations=READ_ONLY)
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

@mcp.tool(annotations=CREATES_ORDER)
def upload_image(imagePath: Annotated[str, Field(description="Local file path or public URL of the primary image")], templateId: Annotated[str, Field(description="Numeric specification ID. Use list_templates to find the right one.")], customerImageId: str = None, productId: str = None,
                 imageCallbackURL: Annotated[str, Field(description="Webhook URL for completion notification")] = None, comment: Annotated[str, Field(description="Instructions for the retouching expert")] = None, markupImageUrl: str = None,
                 customerFolder: str = None, imageDeadlineDateTimeUTC: Annotated[str, Field(description="yyyy-MM-dd HH:mm:ss, must be at least 24h in future")] = None,
                 imageURL2: str = None, imageURL3: str = None, imageURL4: str = None, imageURL5: str = None,
                 colorReferenceFileURL: str = None, swatchImageURL: str = None, swatchColorCode: Annotated[str, Field(description="Hex color like #FFFFFF")] = None,
                 markerX: int = None, markerY: int = None, outputFileName: str = None,
                 customerImageColorID: str = None, colorwayIds: Annotated[list[int], Field(description="Array of color library IDs from add_color_library")] = None) -> str:
    """Submit an image for professional manual retouching on the Pixelz Platform. Creates a billable retouching order. Accepts a local file path (images only) or public URL — local files are uploaded to S3 automatically. Returns an ImageTicket GUID; use get_image_status to track progress."""
    try:
        _validate_required_str(imagePath, 'imagePath')
        _validate_required_str(templateId, 'templateId')
        _validate_hex_color(swatchColorCode, 'swatchColorCode')
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

@mcp.tool(annotations=CREATES_ORDER)
def white_glove_service(imagePath: Annotated[str, Field(description="Local file path or public URL")], comment: Annotated[str, Field(description="Instructions or context for the specialist")] = None, markupImageUrl: str = None,
                        imageURL2: str = None, imageURL3: str = None, imageURL4: str = None, imageURL5: str = None,
                        colorReferenceFileURL: str = None,
                        customerImageId: str = None, productId: str = None,
                        customerFolder: str = None, imageCallbackURL: str = None) -> str:
    """Submit an image for retouching when you don't know which template to use. A Pixelz specialist manually reviews and selects the best settings. Creates a billable retouching order. Accepts local file path or public URL."""
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

@mcp.tool(annotations=CREATES_ORDER)
def stack_image(imagePath: Annotated[str, Field(description="Local file path or public URL")], templateId: str = None, customerImageId: str = None,
                productId: Annotated[str, Field(description="Must be identical across all parts of the same stack")] = None, customerFolder: str = None, imageCallbackURL: str = None,
                imageDeadlineDateTimeUTC: str = None) -> str:
    """Submit one part of a multi-image stack (e.g. different angles of the same product). All parts must share the same productId and be submitted within 5 minutes of each other. Creates a billable retouching order. Accepts local file path or public URL."""
    try:
        _validate_required_str(imagePath, 'imagePath')
        log('info', 'Tool called: stack_image', {'templateId': templateId} if templateId else None)
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

@mcp.tool(annotations=READ_ONLY)
def get_image_status(imageTicket: Annotated[str, Field(description="GUID returned by upload_image or white_glove_service")], customerImageId: str = None) -> str:
    """Get the processing status of an uploaded image. Codes: 10 new, 12 download failed, 20 awaiting payment (deprecated), 30 ready for production, 40 returned for production, 60 in production, 62 assigned to editor, 64 downloaded by editor, 66 quality assurance, 70 finished (ready for download), 72/74/76 delivery attempt 1/2/3 failed, 78 delivery failed, 80 delivered, 90 rejected by Pixelz, 95 awaiting your reply, 100 closed, 0 deleted by user, 999 deleted by cleanup. 12, 90 and 95 need user action: tell the user, do not retry. A non-empty FinalImagesURL means a result is downloadable."""
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

@mcp.tool(annotations=READ_ONLY)
def list_images(imageStatus: Annotated[str, Field(description="Filter by numeric status code, or alias: new, in production, production finished, delivered")] = None, excludeImageStatus: Annotated[str, Field(description="Exclude by status code or name")] = None, productId: str = None,
                fromDate: Annotated[str, Field(description="YYYY-MM-DD")] = None, toDate: Annotated[str, Field(description="YYYY-MM-DD")] = None, page: int = None,
                imagesPerPage: Annotated[int, Field(description="Max 100", json_schema_extra={"maximum": 100})] = None,
                # json_schema_extra advertises the enum without pydantic rejecting first, so the check below keeps the [VALIDATION_ERROR] contract.
                sortBy: Annotated[str, Field(json_schema_extra={"enum": list(SORT_BY_VALUES)})] = None,
                isDescending: Annotated[str, Field(json_schema_extra={"enum": list(IS_DESCENDING_VALUES)})] = None) -> str:
    """Search and list images in the account with optional filters. Returns ticket IDs, statuses, and dates. Status accepts any numeric code (see get_image_status); only new/in production/production finished/delivered are aliases for 10/60/70/80."""
    try:
        if imagesPerPage is not None and imagesPerPage > 100:
            raise ValueError("imagesPerPage: must be <= 100")
        _validate_one_of(sortBy, 'sortBy', SORT_BY_VALUES)
        _validate_one_of(isDescending, 'isDescending', IS_DESCENDING_VALUES)
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

@mcp.tool(annotations=READ_ONLY)
def count_images(imageStatus: Annotated[str, Field(description="Filter by numeric status code, or alias: new, in production, production finished, delivered")] = None, fromDate: Annotated[str, Field(description="YYYY-MM-DD")] = None, toDate: Annotated[str, Field(description="YYYY-MM-DD")] = None) -> str:
    """Get a count of images matching the given filters. Faster than list_images when you only need a total number. Status accepts any numeric code (see get_image_status); only new/in production/production finished/delivered are aliases for 10/60/70/80."""
    try:
        log('info', 'Tool called: count_images')
        imageStatus = _resolve_status(imageStatus)
        params = {k: v for k, v in {**get_auth(), 'imageStatus': imageStatus, 'fromDate': fromDate, 'toDate': toDate}.items() if v is not None}
        data = _checked(_session.get(f"{BASE_URL}/Images/Count", params=params, timeout=REQUEST_TIMEOUT))
        check_api_error(data)
        return json.dumps(data, indent=2)
    except Exception as e:
        raise ToolError(_format_error('count_images', e)) from e

@mcp.tool(annotations=READ_ONLY)
def list_product_ids(page: int = None, perPage: int = None) -> str:
    """List product IDs with completion statistics (TodoCount vs DoneCount). Useful for tracking whether an entire product batch has been fully retouched."""
    try:
        log('info', 'Tool called: list_product_ids')
        params = {k: v for k, v in {**get_auth(), 'page': page, 'productIdsPerPage': perPage}.items() if v is not None}
        data = _checked(_session.get(f"{BASE_URL}/ProductIds", params=params, timeout=REQUEST_TIMEOUT))
        check_api_error(data)
        return json.dumps(data, indent=2)
    except Exception as e:
        raise ToolError(_format_error('list_product_ids', e)) from e

@mcp.tool(annotations=DESTRUCTIVE)
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

@mcp.tool(annotations=CREATES_ORDER)
def reject_image(imageTicket: str, comment: Annotated[str, Field(description="Clear description of what needs fixing \u2014 sent directly to the retouching expert")], markupImageUrl: Annotated[str, Field(description="URL to an annotated image showing exactly what needs correcting")] = None, customerImageId: str = None) -> str:
    """Request a correction (redo) for a delivered image. Only valid when status is 80 (Delivered). The image re-enters the production queue at no extra charge. comment is sent directly to the retouching expert."""
    try:
        _validate_required_str(imageTicket, 'imageTicket')
        _validate_required_str(comment, 'comment')
        validate_id(imageTicket, 'imageTicket')
        log('info', 'Tool called: reject_image', {'imageTicket': imageTicket})
        # The documented REJECT payload repeats imageTicket alongside the path segment.
        payload = {k: v for k, v in {**get_auth(), 'imageTicket': imageTicket, 'comment': comment, 'markupImageUrl': markupImageUrl, 'customerImageId': customerImageId}.items() if v is not None}
        data = _checked(_session.put(f"{BASE_URL}/Image/Reject/{imageTicket}", json=payload, timeout=REQUEST_TIMEOUT))
        check_api_error(data)
        return json.dumps(data, indent=2)
    except Exception as e:
        raise ToolError(_format_error('reject_image', e)) from e

@mcp.tool(annotations=READ_ONLY)
def get_contact() -> str:
    """Retrieve account profile including company details and current credit balance (ContactAccountBalance and Currency)."""
    try:
        log('info', 'Tool called: get_contact')
        data = _checked(_session.get(f"{BASE_URL}/Contact", params=get_auth(), timeout=REQUEST_TIMEOUT))
        check_api_error(data)
        return json.dumps(data, indent=2)
    except Exception as e:
        raise ToolError(_format_error('get_contact', e)) from e

@mcp.tool(annotations=READ_ONLY)
def get_invoices(fromDate: Annotated[str, Field(description="YYYY-MM-DD")] = None, toDate: Annotated[str, Field(description="YYYY-MM-DD")] = None, page: int = None, returnUrl: Annotated[str, Field(description="Redirect URL after payment completion")] = None) -> str:
    """Retrieve billing statements. Returns invoice amounts, dates, and payment URLs."""
    try:
        log('info', 'Tool called: get_invoices')
        params = {k: v for k, v in {**get_auth(), 'fromDate': fromDate, 'toDate': toDate, 'page': page, 'returnUrl': returnUrl}.items() if v is not None}
        data = _checked(_session.get(f"{BASE_URL}/Invoices", params=params, timeout=REQUEST_TIMEOUT))
        check_api_error(data)
        return json.dumps(data, indent=2)
    except Exception as e:
        raise ToolError(_format_error('get_invoices', e)) from e

@mcp.tool(annotations=CREATES_ORDER)
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
