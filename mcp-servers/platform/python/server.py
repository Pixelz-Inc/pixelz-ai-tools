import os
import sys
import json
import re
import requests
from dotenv import load_dotenv
from mcp.server.fastmcp import FastMCP

_dotenv_path = os.environ.get('PIXELZ_DOTENV_PATH') or os.path.abspath(os.path.join(os.path.dirname(__file__), '../../../.env'))
load_dotenv(_dotenv_path)

mcp = FastMCP("pixelz-platform-mcp-python")
BASE_URL = 'https://api.pixelz.com/REST.svc/JSON'
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

def get_auth():
    email = os.getenv('PIXELZ_PLATFORM_EMAIL')
    api_key = os.getenv('PIXELZ_PLATFORM_API_KEY')
    if not email or not api_key:
        raise ValueError("[AUTH_ERROR] Missing PIXELZ_PLATFORM_EMAIL or PIXELZ_PLATFORM_API_KEY in .env")
    return {'contactEmail': email, 'contactAPIkey': api_key}

def check_api_error(data):
    if isinstance(data, dict):
        code = data.get('ErrorCode')
        if code is not None and code != 'NoError' and code != 0:
            raise Exception(f"[API_ERROR] {code}: {data.get('Message', '')}")

def ensure_url(input_path):
    if not input_path: return None
    if input_path.startswith(('http://', 'https://')): return input_path
    if not os.path.exists(input_path): raise Exception(f"Local file not found: {input_path}")
    file_size = os.path.getsize(input_path)
    if file_size > MAX_FILE_SIZE:
        raise Exception(f"File too large ({file_size / (1024**3):.2f} GB). Maximum allowed size is 2 GB.")
    auth = get_auth()
    log('info', 'Requesting presigned URL', {'fileName': os.path.basename(input_path)})
    r = requests.post(f"{BASE_URL}/RequestPresignUrls", json={**auth, 'imageNames': [os.path.basename(input_path)]}, timeout=REQUEST_TIMEOUT)
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
    log('info', 'Uploading file to S3', {'fileName': os.path.basename(input_path), 'size': file_size})
    with open(input_path, 'rb') as f:
        requests.put(body[0]['UploadUrl'], data=f, headers={'Content-Type': 'application/octet-stream'}, timeout=REQUEST_TIMEOUT)
    return body[0]['DownloadUrl']

@mcp.tool()
def list_templates() -> str:
    """List all retouching specification templates in the Pixelz account. Call this first to discover the templateId required for upload_image."""
    try:
        log('info', 'Tool called: list_templates')
        data = requests.get(f"{BASE_URL}/Templates", params=get_auth(), timeout=REQUEST_TIMEOUT).json()
        check_api_error(data)
        return json.dumps(data, indent=2)
    except Exception as e:
        log('error', 'list_templates failed', {'error': str(e)})
        return f"Error: {str(e)}"

@mcp.tool()
def get_template_detail(templateId: str) -> str:
    """Get the full technical configuration of a specific Pixelz template, including output format, background type, margins, alignment, and price per image."""
    try:
        validate_id(templateId, 'templateId')
        log('info', 'Tool called: get_template_detail', {'templateId': templateId})
        data = requests.get(f"{BASE_URL}/Template/{templateId}", params=get_auth(), timeout=REQUEST_TIMEOUT).json()
        check_api_error(data)
        return json.dumps(data, indent=2)
    except Exception as e:
        log('error', 'get_template_detail failed', {'error': str(e)})
        return f"Error: {str(e)}"

@mcp.tool()
def upload_image(imagePath: str, templateId: str, customerImageId: str = None, productId: str = None,
                 imageCallbackURL: str = None, comment: str = None, markupImageUrl: str = None,
                 customerFolder: str = None, imageDeadlineDateTimeUTC: str = None,
                 imageURL2: str = None, imageURL3: str = None, imageURL4: str = None, imageURL5: str = None,
                 colorReferenceFileURL: str = None, swatchImageURL: str = None, swatchColorCode: str = None,
                 markerX: float = None, markerY: float = None, outputFileName: str = None,
                 customerImageColorID: str = None) -> str:
    """Submit an image for professional manual retouching. Accepts a local file path or public URL — local files are uploaded to S3 automatically. Returns an ImageTicket GUID; use get_image_status to track progress."""
    try:
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
            'outputFileName': outputFileName, 'customerImageColorID': customerImageColorID
        }.items() if v is not None}
        data = requests.post(f"{BASE_URL}/Image", json=payload, timeout=REQUEST_TIMEOUT).json()
        check_api_error(data)
        return json.dumps(data, indent=2)
    except Exception as e:
        log('error', 'upload_image failed', {'error': str(e)})
        return f"Error: {str(e)}"

@mcp.tool()
def white_glove_service(imagePath: str, comment: str = None, markupImageUrl: str = None,
                        customerImageId: str = None, productId: str = None,
                        customerFolder: str = None, imageCallbackURL: str = None) -> str:
    """Submit an image when you don't know which template to use. A Pixelz specialist manually selects the best settings. Accepts local file path or public URL."""
    try:
        log('info', 'Tool called: white_glove_service')
        url = ensure_url(imagePath)
        payload = {k: v for k, v in {
            **get_auth(), 'imageURL': url, 'comment': comment,
            'markupImageUrl': markupImageUrl, 'customerImageId': customerImageId,
            'productId': productId, 'customerFolder': customerFolder,
            'imageCallbackURL': imageCallbackURL
        }.items() if v is not None}
        data = requests.post(f"{BASE_URL}/WhiteGloveService", json=payload, timeout=REQUEST_TIMEOUT).json()
        check_api_error(data)
        return json.dumps(data, indent=2)
    except Exception as e:
        log('error', 'white_glove_service failed', {'error': str(e)})
        return f"Error: {str(e)}"

@mcp.tool()
def stack_image(imagePath: str, templateId: str = None, customerImageId: str = None,
                productId: str = None, imageCallbackURL: str = None,
                imageDeadlineDateTimeUTC: str = None) -> str:
    """Submit one part of a multi-image stack. All parts must share the same productId and be submitted within 5 minutes of each other. Accepts local file path or public URL."""
    try:
        log('info', 'Tool called: stack_image')
        url = ensure_url(imagePath)
        payload = {k: v for k, v in {
            **get_auth(), 'imageURL': url, 'templateId': templateId,
            'customerImageId': customerImageId, 'productId': productId,
            'imageCallbackURL': imageCallbackURL,
            'imageDeadlineDateTimeUTC': imageDeadlineDateTimeUTC
        }.items() if v is not None}
        data = requests.post(f"{BASE_URL}/StackImage", json=payload, timeout=REQUEST_TIMEOUT).json()
        check_api_error(data)
        return json.dumps(data, indent=2)
    except Exception as e:
        log('error', 'stack_image failed', {'error': str(e)})
        return f"Error: {str(e)}"

@mcp.tool()
def get_image_status(imageTicket: str, customerImageId: str = None) -> str:
    """Get the processing status of an uploaded image. Status codes: 10=New, 60=In Production, 70=Production Finished (QC), 80=Delivered. When status is 80 the FinalImagesURL is ready for download."""
    try:
        validate_id(imageTicket, 'imageTicket')
        log('info', 'Tool called: get_image_status', {'imageTicket': imageTicket})
        params = {**get_auth(), 'customerImageId': customerImageId}
        data = requests.get(f"{BASE_URL}/Image/{imageTicket}", params={k: v for k, v in params.items() if v is not None}, timeout=REQUEST_TIMEOUT).json()
        check_api_error(data)
        return json.dumps(data, indent=2)
    except Exception as e:
        log('error', 'get_image_status failed', {'error': str(e)})
        return f"Error: {str(e)}"

@mcp.tool()
def list_images(imageStatus: str = None, excludeImageStatus: str = None, productId: str = None,
                fromDate: str = None, toDate: str = None, page: int = 1,
                imagesPerPage: int = 10, sortBy: str = None, isDescending: str = None) -> str:
    """Search and list images in the account. Use imageStatus=80 to list delivered images. Returns ticket IDs, statuses, and dates."""
    try:
        log('info', 'Tool called: list_images')
        params = {k: v for k, v in {
            **get_auth(), 'imageStatus': imageStatus, 'excludeImageStatus': excludeImageStatus,
            'productId': productId, 'fromDate': fromDate, 'toDate': toDate,
            'page': page, 'imagesPerPage': imagesPerPage, 'sortBy': sortBy, 'isDescending': isDescending
        }.items() if v is not None}
        data = requests.get(f"{BASE_URL}/Images", params=params, timeout=REQUEST_TIMEOUT).json()
        check_api_error(data)
        return json.dumps(data, indent=2)
    except Exception as e:
        log('error', 'list_images failed', {'error': str(e)})
        return f"Error: {str(e)}"

@mcp.tool()
def count_images(imageStatus: str = None, fromDate: str = None, toDate: str = None) -> str:
    """Get a count of images matching the given filters. Faster than list_images when you only need a total number."""
    try:
        log('info', 'Tool called: count_images')
        params = {k: v for k, v in {**get_auth(), 'imageStatus': imageStatus, 'fromDate': fromDate, 'toDate': toDate}.items() if v is not None}
        data = requests.get(f"{BASE_URL}/Images/Count", params=params, timeout=REQUEST_TIMEOUT).json()
        check_api_error(data)
        return json.dumps(data, indent=2)
    except Exception as e:
        log('error', 'count_images failed', {'error': str(e)})
        return f"Error: {str(e)}"

@mcp.tool()
def list_product_ids(page: int = 1, perPage: int = 10) -> str:
    """List product IDs with completion statistics (TodoCount vs DoneCount). Useful for tracking whether an entire product batch has been fully retouched."""
    try:
        log('info', 'Tool called: list_product_ids')
        data = requests.get(f"{BASE_URL}/ProductIds", params={**get_auth(), 'page': page, 'productIdsPerPage': perPage}, timeout=REQUEST_TIMEOUT).json()
        check_api_error(data)
        return json.dumps(data, indent=2)
    except Exception as e:
        log('error', 'list_product_ids failed', {'error': str(e)})
        return f"Error: {str(e)}"

@mcp.tool()
def delete_image(imageTicket: str) -> str:
    """Cancel and delete an image processing request. Only possible before the image enters production (status < 60). Confirm the ticket with the user before calling."""
    try:
        validate_id(imageTicket, 'imageTicket')
        log('info', 'Tool called: delete_image', {'imageTicket': imageTicket})
        data = requests.delete(f"{BASE_URL}/Image/{imageTicket}", json=get_auth(), timeout=REQUEST_TIMEOUT).json()
        check_api_error(data)
        return json.dumps(data, indent=2)
    except Exception as e:
        log('error', 'delete_image failed', {'error': str(e)})
        return f"Error: {str(e)}"

@mcp.tool()
def reject_image(imageTicket: str, comment: str, markupImageUrl: str = None, customerImageId: str = None) -> str:
    """Request a correction (redo) for a delivered image. Only valid when status is 80 (Delivered). The image re-enters the production queue at no extra charge. comment is sent directly to the retouching expert."""
    try:
        validate_id(imageTicket, 'imageTicket')
        log('info', 'Tool called: reject_image', {'imageTicket': imageTicket})
        payload = {k: v for k, v in {**get_auth(), 'comment': comment, 'markupImageUrl': markupImageUrl, 'customerImageId': customerImageId}.items() if v is not None}
        data = requests.put(f"{BASE_URL}/Image/Reject/{imageTicket}", json=payload, timeout=REQUEST_TIMEOUT).json()
        check_api_error(data)
        return json.dumps(data, indent=2)
    except Exception as e:
        log('error', 'reject_image failed', {'error': str(e)})
        return f"Error: {str(e)}"

@mcp.tool()
def get_contact() -> str:
    """Retrieve account profile including company details and current credit balance (ContactAccountBalance and Currency)."""
    try:
        log('info', 'Tool called: get_contact')
        data = requests.get(f"{BASE_URL}/Contact", params=get_auth(), timeout=REQUEST_TIMEOUT).json()
        check_api_error(data)
        return json.dumps(data, indent=2)
    except Exception as e:
        log('error', 'get_contact failed', {'error': str(e)})
        return f"Error: {str(e)}"

@mcp.tool()
def get_invoices(fromDate: str = None, toDate: str = None, page: int = 1, returnUrl: str = None) -> str:
    """Retrieve billing statements. Returns invoice amounts, dates, and payment URLs. returnUrl is a redirect URL after payment completion."""
    try:
        log('info', 'Tool called: get_invoices')
        params = {k: v for k, v in {**get_auth(), 'fromDate': fromDate, 'toDate': toDate, 'page': page, 'returnUrl': returnUrl}.items() if v is not None}
        data = requests.get(f"{BASE_URL}/Invoices", params=params, timeout=REQUEST_TIMEOUT).json()
        check_api_error(data)
        return json.dumps(data, indent=2)
    except Exception as e:
        log('error', 'get_invoices failed', {'error': str(e)})
        return f"Error: {str(e)}"

if __name__ == "__main__":
    mcp.run()
