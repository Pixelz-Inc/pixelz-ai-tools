import os
import pytest
from unittest.mock import patch
from conftest import load_platform_server


@patch.dict(os.environ, {
    'PIXELZ_DOTENV_PATH': '/dev/null',
    'PIXELZ_PLATFORM_EMAIL': 'test@example.com',
    'PIXELZ_PLATFORM_API_KEY': 'key123',
}, clear=False)
def test_ensure_url_passes_https_through():
    mod = load_platform_server()
    assert mod.ensure_url('https://example.com/image.jpg') == 'https://example.com/image.jpg'


@patch.dict(os.environ, {
    'PIXELZ_DOTENV_PATH': '/dev/null',
    'PIXELZ_PLATFORM_EMAIL': 'test@example.com',
    'PIXELZ_PLATFORM_API_KEY': 'key123',
}, clear=False)
def test_ensure_url_passes_http_through():
    mod = load_platform_server()
    assert mod.ensure_url('http://example.com/image.jpg') == 'http://example.com/image.jpg'


@patch.dict(os.environ, {
    'PIXELZ_DOTENV_PATH': '/dev/null',
    'PIXELZ_PLATFORM_EMAIL': 'test@example.com',
    'PIXELZ_PLATFORM_API_KEY': 'key123',
}, clear=False)
def test_ensure_url_returns_none_for_empty():
    mod = load_platform_server()
    assert mod.ensure_url('') is None


@patch.dict(os.environ, {
    'PIXELZ_DOTENV_PATH': '/dev/null',
    'PIXELZ_PLATFORM_EMAIL': 'test@example.com',
    'PIXELZ_PLATFORM_API_KEY': 'key123',
}, clear=False)
def test_ensure_url_raises_for_nonexistent_file():
    mod = load_platform_server()
    with pytest.raises(Exception, match='Local file not found'):
        mod.ensure_url('/nonexistent/file.jpg')


@patch.dict(os.environ, {
    'PIXELZ_DOTENV_PATH': '/dev/null',
    'PIXELZ_PLATFORM_EMAIL': 'test@example.com',
    'PIXELZ_PLATFORM_API_KEY': 'key123',
}, clear=False)
def test_validate_id_accepts_valid():
    mod = load_platform_server()
    mod.validate_id('abc-123_DEF', 'test')


@patch.dict(os.environ, {
    'PIXELZ_DOTENV_PATH': '/dev/null',
    'PIXELZ_PLATFORM_EMAIL': 'test@example.com',
    'PIXELZ_PLATFORM_API_KEY': 'key123',
}, clear=False)
def test_validate_id_rejects_path_traversal():
    mod = load_platform_server()
    with pytest.raises(ValueError, match='Invalid test'):
        mod.validate_id('../../../etc/passwd', 'test')
