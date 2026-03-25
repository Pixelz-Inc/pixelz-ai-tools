import os
import pytest
from unittest.mock import patch
from conftest import load_automation_server


@patch.dict(os.environ, {
    'PIXELZ_DOTENV_PATH': '/dev/null',
    'PIXELZ_AUTOMATION_CLIENT_ID': 'client123',
    'PIXELZ_AUTOMATION_CLIENT_SECRET': 'secret456',
}, clear=False)
def test_ensure_url_or_id_passes_https_through():
    mod = load_automation_server()
    assert mod.ensure_url_or_id('https://example.com/img.jpg', 'token') == 'https://example.com/img.jpg'


@patch.dict(os.environ, {
    'PIXELZ_DOTENV_PATH': '/dev/null',
    'PIXELZ_AUTOMATION_CLIENT_ID': 'client123',
    'PIXELZ_AUTOMATION_CLIENT_SECRET': 'secret456',
}, clear=False)
def test_ensure_url_or_id_returns_none_for_empty():
    mod = load_automation_server()
    assert mod.ensure_url_or_id('', 'token') is None


@patch.dict(os.environ, {
    'PIXELZ_DOTENV_PATH': '/dev/null',
    'PIXELZ_AUTOMATION_CLIENT_ID': 'client123',
    'PIXELZ_AUTOMATION_CLIENT_SECRET': 'secret456',
}, clear=False)
def test_ensure_url_or_id_raises_for_nonexistent_file():
    mod = load_automation_server()
    with pytest.raises(Exception, match='Local file not found'):
        mod.ensure_url_or_id('/nonexistent/file.jpg', 'token')


@patch.dict(os.environ, {
    'PIXELZ_DOTENV_PATH': '/dev/null',
    'PIXELZ_AUTOMATION_CLIENT_ID': 'client123',
    'PIXELZ_AUTOMATION_CLIENT_SECRET': 'secret456',
}, clear=False)
def test_validate_id_accepts_valid():
    mod = load_automation_server()
    mod.validate_id('job-abc_123', 'jobId')


@patch.dict(os.environ, {
    'PIXELZ_DOTENV_PATH': '/dev/null',
    'PIXELZ_AUTOMATION_CLIENT_ID': 'client123',
    'PIXELZ_AUTOMATION_CLIENT_SECRET': 'secret456',
}, clear=False)
def test_validate_id_rejects_path_traversal():
    mod = load_automation_server()
    with pytest.raises(ValueError, match='Invalid jobId'):
        mod.validate_id('../../../etc/passwd', 'jobId')
