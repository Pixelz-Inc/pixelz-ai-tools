import os
from unittest.mock import patch, MagicMock

import pytest
import requests

from conftest import PROJECT_ROOT, load_platform_server

ENV = {
    'PIXELZ_DOTENV_PATH': '/dev/null',
    'PIXELZ_PLATFORM_EMAIL': 'test@example.com',
    'PIXELZ_PLATFORM_API_KEY': 'key123',
}


def _response(status, body):
    """A requests-like double whose raise_for_status behaves like the real thing."""
    r = MagicMock()
    r.status_code = status
    r.json.return_value = body
    if status >= 400:
        err = requests.exceptions.HTTPError(f"{status} Error", response=r)
        r.raise_for_status.side_effect = err
    else:
        r.raise_for_status.return_value = None
    return r


@patch.dict(os.environ, ENV, clear=False)
def test_checked_raises_on_error_status_even_without_errorcode():
    """
    The defect this guards: check_api_error only inspects the body's ErrorCode, so a 4xx/5xx
    whose body carries no ErrorCode was returned to the agent as a successful tool result.
    """
    mod = load_platform_server()
    with pytest.raises(requests.exceptions.HTTPError):
        mod._checked(_response(401, {'message': 'Unauthorized'}))


@patch.dict(os.environ, ENV, clear=False)
def test_checked_returns_body_on_success():
    mod = load_platform_server()
    assert mod._checked(_response(200, {'ErrorCode': 'NoError'})) == {'ErrorCode': 'NoError'}


@patch.dict(os.environ, ENV, clear=False)
def test_error_status_is_formatted_as_http_prefix():
    """
    _format_error's HTTPError branch was unreachable for the 14 direct API calls before
    _checked existed, so [HTTP_<status>] was never produced for a tool call.
    """
    mod = load_platform_server()
    try:
        mod._checked(_response(503, {'message': 'upstream down'}))
    except requests.exceptions.HTTPError as e:
        assert mod._format_error('list_templates', e).startswith('Error: [HTTP_503]')
    else:
        pytest.fail("expected HTTPError")


@patch.dict(os.environ, ENV, clear=False)
def test_every_tool_request_goes_through_the_status_check():
    """
    Guards the fix from being partially reverted: the tool handlers must not call .json()
    straight off a response, which is what skipped the status check on 14 of 16 requests.
    """
    server_py = os.path.join(PROJECT_ROOT, 'mcp-servers', 'platform', 'python', 'server.py')
    with open(server_py, encoding='utf-8') as f:
        source = f.read()
    assert '_session.get(' in source, "sanity check: expected session calls in the server"
    offenders = [
        line.strip()
        for line in source.splitlines()
        if '_session.' in line and ').json()' in line
    ]
    assert offenders == [], f"unchecked response.json() calls: {offenders}"


@patch.dict(os.environ, ENV, clear=False)
def test_s3_upload_failure_is_not_reported_as_success():
    """
    ensure_url returned the DownloadUrl unconditionally, so a failed S3 PUT produced a URL
    for an object that was never stored and the retouching job was created against it.
    """
    mod = load_platform_server()
    presign = _response(200, [{'UploadUrl': 'https://s3.example/put', 'DownloadUrl': 'https://s3.example/get'}])
    put = _response(403, {'message': 'signature expired'})

    with patch.object(mod._session, 'post', return_value=presign), \
         patch.object(mod._session, 'put', return_value=put):
        with pytest.raises(requests.exceptions.HTTPError):
            mod.ensure_url(os.path.abspath(__file__))
