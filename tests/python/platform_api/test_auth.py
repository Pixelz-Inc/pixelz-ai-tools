import os
import pytest
from unittest.mock import patch
from conftest import load_platform_server


@patch.dict(os.environ, {
    'PIXELZ_DOTENV_PATH': '/dev/null',
    'PIXELZ_PLATFORM_EMAIL': 'test@example.com',
    'PIXELZ_PLATFORM_API_KEY': 'key123',
}, clear=False)
def test_get_auth_returns_correct_object():
    mod = load_platform_server()
    auth = mod.get_auth()
    assert auth == {'contactEmail': 'test@example.com', 'contactAPIkey': 'key123'}


@patch.dict(os.environ, {
    'PIXELZ_DOTENV_PATH': '/dev/null',
    'PIXELZ_PLATFORM_EMAIL': 'test@example.com',
    'PIXELZ_PLATFORM_API_KEY': 'key123',
    'PIXELZ_PLATFORM_DEVELOPER_KEY': 'devkey456',
}, clear=False)
def test_get_auth_does_not_include_developer_key():
    mod = load_platform_server()
    auth = mod.get_auth()
    assert 'developerAPIkey' not in auth


@patch.dict(os.environ, {'PIXELZ_DOTENV_PATH': '/dev/null'}, clear=False)
def test_get_auth_raises_when_email_missing():
    os.environ.pop('PIXELZ_PLATFORM_EMAIL', None)
    os.environ.pop('PIXELZ_PLATFORM_API_KEY', None)
    mod = load_platform_server()
    with pytest.raises(ValueError, match='AUTH_ERROR'):
        mod.get_auth()


@patch.dict(os.environ, {
    'PIXELZ_DOTENV_PATH': '/dev/null',
    'PIXELZ_PLATFORM_EMAIL': 'test@example.com',
    'PIXELZ_PLATFORM_API_KEY': 'key123',
}, clear=False)
def test_check_api_error_no_error():
    mod = load_platform_server()
    mod.check_api_error({'ErrorCode': 'NoError'})
    mod.check_api_error({'ErrorCode': 0})
    mod.check_api_error([{'id': 1}])


@patch.dict(os.environ, {
    'PIXELZ_DOTENV_PATH': '/dev/null',
    'PIXELZ_PLATFORM_EMAIL': 'test@example.com',
    'PIXELZ_PLATFORM_API_KEY': 'key123',
}, clear=False)
def test_check_api_error_raises_on_error():
    mod = load_platform_server()
    with pytest.raises(Exception, match='API_ERROR'):
        mod.check_api_error({'ErrorCode': 'InvalidTemplate', 'Message': 'Not found'})
