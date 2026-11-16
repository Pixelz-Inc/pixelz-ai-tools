"""HTTP session, redaction, logging, argument parsing and validation shared by the Python CLIs and MCP servers."""
import argparse
import json
import os
import re
import sys
from urllib.parse import quote, quote_plus
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from dotenv import load_dotenv

MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024  # 2 GB

def load_env(consumer_file):
    """Load the root .env (PIXELZ_DOTENV_PATH wins), located three levels above the consumer's folder."""
    load_dotenv(os.environ.get('PIXELZ_DOTENV_PATH') or os.path.abspath(os.path.join(os.path.dirname(consumer_file), '../../../.env')))

def is_read_timeout(e):
    """requests reports a timeout while reading the body as ConnectionError(ReadTimeoutError)."""
    import urllib3
    return bool(e.args) and isinstance(e.args[0], urllib3.exceptions.ReadTimeoutError)

def make_session():
    """A requests session that retries idempotent requests on transient failures."""
    # raise_on_status=False: once retries run out, hand back the last response so raise_for_status()
    # reports [HTTP_<status>] (as Node does) instead of an uncategorized RetryError.
    # retry_after_max: the same 60 s ceiling as Node, so a huge Retry-After cannot park a call for hours.
    retry = Retry(total=3, backoff_factor=1, status_forcelist=[429, 502, 503, 504], respect_retry_after_header=True,
                  raise_on_status=False, retry_after_max=60)
    session = requests.Session()
    session.mount('https://', HTTPAdapter(max_retries=retry))
    session.mount('http://', HTTPAdapter(max_retries=retry))
    return session

def make_redactor(env_keys, param_names):
    """Build redact_secrets for one API: the env vars holding its credentials and the param names carrying them.

    The returned function replaces known credential values and bearer tokens in text with <REDACTED>.
    """
    param_pattern = re.compile(r'(' + '|'.join(re.escape(n) for n in param_names) + r')=[^&\s\'"]*', re.IGNORECASE)

    def redact_secrets(text):
        s = str(text)
        for key in env_keys:
            val = os.getenv(key)
            if not val:
                continue
            for variant in {val, quote(val, safe=''), quote_plus(val)}:
                s = s.replace(variant, '<REDACTED>')
        s = param_pattern.sub(r'\1=<REDACTED>', s)
        s = re.sub(r'eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', '<REDACTED>', s)
        return s

    return redact_secrets

def make_logger(redact_secrets):
    """Build log(): appends to PIXELZ_LOG_FILE (read when this is called) if set, else does nothing."""
    log_file = os.getenv('PIXELZ_LOG_FILE')

    def log(level, message, data=None):
        if not log_file:
            return
        from datetime import datetime, timezone
        entry = f"[{datetime.now(timezone.utc).isoformat()}] [{level}] {message}"
        if data is not None:
            entry += f" {json.dumps(data, default=str)}"
        # Redacted here, not at call sites: error text can carry a credentialed request URL.
        try:
            with open(log_file, 'a') as f:
                f.write(redact_secrets(entry) + '\n')
        except Exception as err:  # logging must never fail a tool call
            sys.stderr.write(f'Log write failed: {err}\n')

    return log

def validate_id(value, name):
    if not isinstance(value, str) or value == '':
        raise ValueError(f"[VALIDATION_ERROR] {name} is required")
    # fullmatch, not match: `$` would accept a trailing newline.
    if not re.fullmatch(r'[a-zA-Z0-9_\-]+', value):
        raise ValueError(f"[VALIDATION_ERROR] Invalid {name}: contains unexpected characters")

# The Automation API accepts only these image types; the keys double as the upload allowlist.
AUTOMATION_MIME_TYPES = {'.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp'}
AUTOMATION_UPLOAD_EXTENSIONS = tuple(AUTOMATION_MIME_TYPES)
# A best guess at what the Platform API retouches; PIXELZ_UPLOAD_ANY_FILE_TYPE=true bypasses it if wrong.
PLATFORM_UPLOAD_EXTENSIONS = (
    '.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff', '.psd', '.psb', '.gif', '.bmp', '.heic', '.heif',
    '.dng', '.cr2', '.cr3', '.nef', '.arw', '.raf', '.orf', '.rw2',
)

def resolve_local_file(input_path, allowed_extensions):
    """Validate a local upload source; return (resolved_path, size_in_bytes).

    The extension allowlist is checked before any network call so an agent cannot ship .env or key
    files to a third-party bucket.
    """
    if not os.path.exists(input_path):
        raise Exception(f"[VALIDATION_ERROR] Local file not found: {input_path}")
    resolved = os.path.realpath(input_path)
    if not os.path.isfile(resolved):
        raise Exception(f"[VALIDATION_ERROR] Not a regular file: {input_path}")
    if os.environ.get('PIXELZ_UPLOAD_ANY_FILE_TYPE') != 'true':
        # The resolved path: that is the file (and name) actually uploaded, so a symlink cannot launder an extension.
        ext = os.path.splitext(resolved)[1].lower()
        if ext not in allowed_extensions:
            raise Exception(f'[VALIDATION_ERROR] Unsupported file type "{ext}" for upload. Allowed: {", ".join(allowed_extensions)}.')
    file_size = os.path.getsize(resolved)
    if file_size > MAX_FILE_SIZE:
        raise Exception(f"[VALIDATION_ERROR] File too large ({file_size / (1024**3):.2f} GB). Maximum allowed size is 2 GB.")
    return resolved, file_size

def is_url(input_path):
    return input_path.startswith(('http://', 'https://'))

HEX_COLOR = re.compile(r'#[0-9A-Fa-f]{6}')

# The 17 values of the API's top_crop_location / bottom_crop_location enum.
CROP_LOCATIONS = (
    'eye_higher', 'below_eye', 'btw_eye_and_nose', 'below_nose',
    'between_nose_and_mouth', 'below_mouth', 'below_chin', 'chest',
    'at_elbow_higher', 'at_elbow_lower', 'waist', 'below_buttock',
    'main_body_axis', 'mid_thigh', 'above_knee', 'at_knee', 'below_knee',
)

UPLOAD_UNAVAILABLE = ('[UPLOAD_UNAVAILABLE] HTTP 403: the account may not be enabled for direct file uploads '
                      '(off by default on the Automation API). Provide a publicly accessible image URL instead of a local file path.')

STATUS_ALIASES = {
    'new': '10', 'in production': '60', 'production finished': '70', 'delivered': '80'
}

def resolve_status(value):
    if value is None:
        return value
    lower = str(value).lower()
    return STATUS_ALIASES.get(lower, value)

def check_api_error(data):
    if isinstance(data, dict):
        code = data.get('ErrorCode')
        if code is not None and code != 'NoError' and code != 0:
            raise Exception(f"[API_ERROR] {code}: {data.get('Message', '')}")

def parse_platform_presign(body):
    """Validate a Platform RequestPresignUrls response; return its first upload target ({'UploadUrl', 'DownloadUrl', ...})."""
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
    return posting_urls[0]

def read_repo_version(consumer_file):
    """The repo-root package.json (three levels above the consumer's folder) is the single version source; a missing file must not stop the server."""
    try:
        with open(os.path.join(os.path.dirname(consumer_file), '../../../package.json'), encoding='utf-8') as f:
            return json.load(f).get('version') or '0.0.0'
    except Exception:
        return '0.0.0'

def validate_required_str(value, name):
    if not value or not str(value).strip():
        raise ValueError(f"{name}: must be a non-empty string")

def validate_hex_color(value, name):
    if value is not None and not HEX_COLOR.fullmatch(value):
        raise ValueError(f"{name}: must be a hex color like #FFFFFF")

# --- Command-line parsing (argparse) ---------------------------------------------------------
# Usage errors are reported as a categorised "[VALIDATION_ERROR] <command>: <message>" line with
# exit code 1, the same line and code the Node CLI produces. Only an unknown command exits 2.

class CliParser(argparse.ArgumentParser):
    def __init__(self, *args, **kwargs):
        # Abbreviated flags (--feat for --feather) are rejected by the Node CLI, so reject them here too.
        kwargs.setdefault('allow_abbrev', False)
        super().__init__(*args, **kwargs)

    def error(self, message):
        command = self.prog.split()[-1]
        required = re.match(r'the following arguments are required: (.+)', message)
        if required:
            names = [n if n.startswith('-') else f'<{n}>' for n in required.group(1).split(', ')]
            message = f"{command} requires {', '.join(names)}"
        else:
            message = f"{command}: {message}"
        print(f"[VALIDATION_ERROR] {message}", file=sys.stderr)
        sys.exit(1)

class RootParser(CliParser):
    def error(self, message):
        invalid = re.match(r"argument command: invalid choice: '?(.+?)'? \(choose from", message)
        if invalid:
            self.unknown_command(invalid.group(1))
        super().error(message)

    def unknown_command(self, name):
        # stderr and non-zero, so an agent cannot mistake the usage text for a successful result.
        print(f"[VALIDATION_ERROR] unknown command '{name}'\n", file=sys.stderr)
        self.print_help(sys.stderr)
        sys.exit(2)

def parse_cli_args(parser):
    """Parse sys.argv with a RootParser; returns None after printing help when no command was given."""
    args, extras = parser.parse_known_args()
    if not args.command:
        if extras:
            parser.unknown_command(extras[0])
        parser.print_help()
        return None
    if extras:
        CliParser(prog=args.command).error(f"unrecognized arguments: {' '.join(extras)}")
    return args

def int_arg(value):
    if not re.fullmatch(r'\s*[+-]?\d+\s*', value):
        raise argparse.ArgumentTypeError(f"invalid int value: '{value}'")
    return int(value)

_FLOAT_PATTERN = re.compile(r'\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*')

def float_arg(value):
    # Finite only: argparse's float() also takes nan/inf, which json.dumps would send as invalid JSON.
    if not _FLOAT_PATTERN.fullmatch(value) or float(value) in (float('inf'), float('-inf')):
        raise argparse.ArgumentTypeError(f"invalid float value: '{value}'")
    return float(value)

def true_false_arg(value):
    if value not in ('true', 'false'):
        raise argparse.ArgumentTypeError(f"invalid choice: '{value}' (choose from 'true', 'false')")
    return value
