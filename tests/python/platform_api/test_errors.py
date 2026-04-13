import os
import pytest
from unittest.mock import patch, MagicMock
from conftest import load_platform_server


@patch.dict(os.environ, {
    'PIXELZ_DOTENV_PATH': '/dev/null',
    'PIXELZ_PLATFORM_EMAIL': 'secret@example.com',
    'PIXELZ_PLATFORM_API_KEY': 'my_api_key_123',
}, clear=False)
def test_redact_secrets_hides_credentials():
    mod = load_platform_server()
    result = mod.redact_secrets('Auth failed for secret@example.com with key my_api_key_123')
    assert 'secret@example.com' not in result
    assert 'my_api_key_123' not in result
    assert '<REDACTED>' in result


@patch.dict(os.environ, {
    'PIXELZ_DOTENV_PATH': '/dev/null',
    'PIXELZ_PLATFORM_EMAIL': 'test@example.com',
    'PIXELZ_PLATFORM_API_KEY': 'key123',
}, clear=False)
def test_format_error_timeout():
    import requests
    mod = load_platform_server()
    err = requests.exceptions.Timeout('Connection timed out')
    result = mod._format_error('test_tool', err)
    assert '[TIMEOUT]' in result


@patch.dict(os.environ, {
    'PIXELZ_DOTENV_PATH': '/dev/null',
    'PIXELZ_PLATFORM_EMAIL': 'test@example.com',
    'PIXELZ_PLATFORM_API_KEY': 'key123',
}, clear=False)
def test_format_error_connection():
    import requests
    mod = load_platform_server()
    err = requests.exceptions.ConnectionError('Connection refused')
    result = mod._format_error('test_tool', err)
    assert '[NETWORK_ERROR]' in result


@patch.dict(os.environ, {
    'PIXELZ_DOTENV_PATH': '/dev/null',
    'PIXELZ_PLATFORM_EMAIL': 'test@example.com',
    'PIXELZ_PLATFORM_API_KEY': 'key123',
}, clear=False)
def test_format_error_http_error():
    import requests
    mod = load_platform_server()
    mock_response = MagicMock()
    mock_response.status_code = 500
    mock_response.json.return_value = {'error': 'Server error'}
    err = requests.exceptions.HTTPError(response=mock_response)
    result = mod._format_error('test_tool', err)
    assert '[HTTP_500]' in result


@patch.dict(os.environ, {
    'PIXELZ_DOTENV_PATH': '/dev/null',
    'PIXELZ_PLATFORM_EMAIL': 'test@example.com',
    'PIXELZ_PLATFORM_API_KEY': 'key123',
}, clear=False)
def test_format_error_validation():
    mod = load_platform_server()
    err = ValueError('templateId is required')
    result = mod._format_error('test_tool', err)
    assert '[VALIDATION_ERROR]' in result


@patch.dict(os.environ, {
    'PIXELZ_DOTENV_PATH': '/dev/null',
    'PIXELZ_PLATFORM_EMAIL': 'test@example.com',
    'PIXELZ_PLATFORM_API_KEY': 'key123',
}, clear=False)
def test_ensure_url_rejects_directory():
    mod = load_platform_server()
    with pytest.raises(Exception, match='Not a regular file'):
        mod.ensure_url('.')


@patch.dict(os.environ, {
    'PIXELZ_DOTENV_PATH': '/dev/null',
    'PIXELZ_PLATFORM_EMAIL': 'test@example.com',
    'PIXELZ_PLATFORM_API_KEY': 'key123',
}, clear=False)
def test_check_api_error_with_error_code():
    mod = load_platform_server()
    with pytest.raises(Exception, match='API_ERROR'):
        mod.check_api_error({'ErrorCode': 'InvalidImage', 'Message': 'Image not found'})
