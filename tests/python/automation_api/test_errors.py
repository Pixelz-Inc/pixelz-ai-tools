import os
import time
import pytest
from unittest.mock import patch, MagicMock
from conftest import load_automation_server


@patch.dict(os.environ, {
    'PIXELZ_DOTENV_PATH': '/dev/null',
    'PIXELZ_AUTOMATION_CLIENT_ID': 'client123',
    'PIXELZ_AUTOMATION_CLIENT_SECRET': 'secret456',
}, clear=False)
def test_redact_secrets_hides_credentials():
    mod = load_automation_server()
    result = mod.redact_secrets('Error with client123 and secret456')
    assert 'client123' not in result
    assert 'secret456' not in result
    assert '<REDACTED>' in result


@patch.dict(os.environ, {
    'PIXELZ_DOTENV_PATH': '/dev/null',
    'PIXELZ_AUTOMATION_CLIENT_ID': 'client123',
    'PIXELZ_AUTOMATION_CLIENT_SECRET': 'secret456',
}, clear=False)
def test_redact_secrets_hides_jwt():
    mod = load_automation_server()
    jwt = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature'
    result = mod.redact_secrets(f'Bearer {jwt}')
    assert 'eyJ' not in result
    assert '<REDACTED>' in result


@patch.dict(os.environ, {
    'PIXELZ_DOTENV_PATH': '/dev/null',
    'PIXELZ_AUTOMATION_CLIENT_ID': 'client123',
    'PIXELZ_AUTOMATION_CLIENT_SECRET': 'secret456',
}, clear=False)
def test_format_error_timeout():
    import requests
    mod = load_automation_server()
    err = requests.exceptions.Timeout('Connection timed out')
    result = mod._format_error('test_tool', err)
    assert '[TIMEOUT]' in result


@patch.dict(os.environ, {
    'PIXELZ_DOTENV_PATH': '/dev/null',
    'PIXELZ_AUTOMATION_CLIENT_ID': 'client123',
    'PIXELZ_AUTOMATION_CLIENT_SECRET': 'secret456',
}, clear=False)
def test_format_error_connection():
    import requests
    mod = load_automation_server()
    err = requests.exceptions.ConnectionError('Connection refused')
    result = mod._format_error('test_tool', err)
    assert '[NETWORK_ERROR]' in result


@patch.dict(os.environ, {
    'PIXELZ_DOTENV_PATH': '/dev/null',
    'PIXELZ_AUTOMATION_CLIENT_ID': 'client123',
    'PIXELZ_AUTOMATION_CLIENT_SECRET': 'secret456',
}, clear=False)
def test_format_error_http_error():
    import requests
    mod = load_automation_server()
    mock_response = MagicMock()
    mock_response.status_code = 404
    mock_response.json.return_value = {'error': 'Not found'}
    err = requests.exceptions.HTTPError(response=mock_response)
    result = mod._format_error('test_tool', err)
    assert '[HTTP_404]' in result


@patch.dict(os.environ, {
    'PIXELZ_DOTENV_PATH': '/dev/null',
    'PIXELZ_AUTOMATION_CLIENT_ID': 'client123',
    'PIXELZ_AUTOMATION_CLIENT_SECRET': 'secret456',
}, clear=False)
def test_format_error_validation():
    mod = load_automation_server()
    err = ValueError('imagePath is required')
    result = mod._format_error('test_tool', err)
    assert '[VALIDATION_ERROR]' in result


@patch.dict(os.environ, {
    'PIXELZ_DOTENV_PATH': '/dev/null',
    'PIXELZ_AUTOMATION_CLIENT_ID': 'client123',
    'PIXELZ_AUTOMATION_CLIENT_SECRET': 'secret456',
}, clear=False)
def test_token_caching():
    mod = load_automation_server()
    mod._token_cache['token'] = None
    mod._token_cache['expires_at'] = 0

    mock_response = MagicMock()
    mock_response.json.return_value = {'access_token': 'cached_tok', 'expires_in': 3600}
    mock_response.raise_for_status = MagicMock()

    with patch.object(mod._session, 'post', return_value=mock_response) as mock_post:
        token1 = mod.get_token()
        token2 = mod.get_token()
        assert token1 == 'cached_tok'
        assert token2 == 'cached_tok'
        assert mock_post.call_count == 1


@patch.dict(os.environ, {
    'PIXELZ_DOTENV_PATH': '/dev/null',
    'PIXELZ_AUTOMATION_CLIENT_ID': 'client123',
    'PIXELZ_AUTOMATION_CLIENT_SECRET': 'secret456',
}, clear=False)
def test_token_refresh_on_expiry():
    mod = load_automation_server()
    mod._token_cache['token'] = 'old_token'
    mod._token_cache['expires_at'] = time.time() - 1  # already expired

    mock_response = MagicMock()
    mock_response.json.return_value = {'access_token': 'new_token', 'expires_in': 3600}
    mock_response.raise_for_status = MagicMock()

    with patch.object(mod._session, 'post', return_value=mock_response):
        token = mod.get_token()
        assert token == 'new_token'


@patch.dict(os.environ, {
    'PIXELZ_DOTENV_PATH': '/dev/null',
    'PIXELZ_AUTOMATION_CLIENT_ID': 'client123',
    'PIXELZ_AUTOMATION_CLIENT_SECRET': 'secret456',
}, clear=False)
def test_ensure_url_or_id_rejects_directory():
    mod = load_automation_server()
    with pytest.raises(Exception, match='Not a regular file'):
        mod.ensure_url_or_id('.', 'token')


@patch.dict(os.environ, {
    'PIXELZ_DOTENV_PATH': '/dev/null',
    'PIXELZ_AUTOMATION_CLIENT_ID': 'client123',
    'PIXELZ_AUTOMATION_CLIENT_SECRET': 'secret456',
}, clear=False)
def test_format_error_keeps_auth_errors_out_of_validation():
    """get_auth/get_token raise ValueError('[AUTH_ERROR] ...'); it was shown to agents as
    '[VALIDATION_ERROR] [AUTH_ERROR] ...'."""
    mod = load_automation_server()
    result = mod._format_error('test_tool', ValueError('[AUTH_ERROR] Missing credentials'))
    assert result == '[AUTH_ERROR] Missing credentials'
