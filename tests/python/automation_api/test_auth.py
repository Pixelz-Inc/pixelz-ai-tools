import os
import pytest
from unittest.mock import patch, MagicMock
from conftest import load_automation_server


@patch.dict(os.environ, {'PIXELZ_DOTENV_PATH': '/dev/null'}, clear=False)
def test_get_token_raises_when_credentials_missing():
    os.environ.pop('PIXELZ_AUTOMATION_CLIENT_ID', None)
    os.environ.pop('PIXELZ_AUTOMATION_CLIENT_SECRET', None)
    mod = load_automation_server()
    with pytest.raises(ValueError, match='AUTH_ERROR'):
        mod.get_token()


@patch.dict(os.environ, {
    'PIXELZ_DOTENV_PATH': '/dev/null',
    'PIXELZ_AUTOMATION_CLIENT_ID': 'client123',
    'PIXELZ_AUTOMATION_CLIENT_SECRET': 'secret456',
}, clear=False)
def test_get_token_returns_access_token():
    mod = load_automation_server()
    mod._token_cache['token'] = None
    mod._token_cache['expires_at'] = 0

    mock_response = MagicMock()
    mock_response.json.return_value = {'access_token': 'token_abc', 'expires_in': 3600}
    mock_response.raise_for_status = MagicMock()

    with patch.object(mod.requests, 'post', return_value=mock_response):
        token = mod.get_token()
        assert token == 'token_abc'
