import os
from unittest.mock import patch, MagicMock

import pytest

from conftest import load_automation_server

ENV = {
    'PIXELZ_DOTENV_PATH': '/dev/null',
    'PIXELZ_AUTOMATION_CLIENT_ID': 'client123',
    'PIXELZ_AUTOMATION_CLIENT_SECRET': 'secret456',
}
IMG = 'https://example.com/shirt.jpg'


def _call(mod, **kwargs):
    """Run remove_background against a stubbed session; return (result, posted JSON or None)."""
    ok = MagicMock(status_code=201)
    ok.json.return_value = {'job_id': 'job-1'}
    with patch.object(mod, 'get_token', return_value='tok'), \
         patch.object(mod._session, 'post', return_value=ok) as post:
        result = mod.remove_background(imagePath=IMG, **kwargs)
    return result, (post.call_args.kwargs['json'] if post.called else None)


# The API spec: "choose only one ... Do not set both, and do not leave both unset."
# The MCP tool defaulted transparentBackground to True, so a colour request sent both.

@patch.dict(os.environ, ENV, clear=False)
def test_background_color_alone_disables_transparency():
    _, body = _call(load_automation_server(), backgroundColor='#FFFFFF')
    assert body['background_color'] == '#FFFFFF'
    assert body['transparent_background'] is False


@patch.dict(os.environ, ENV, clear=False)
def test_defaults_to_transparent_without_a_color():
    _, body = _call(load_automation_server())
    assert body['transparent_background'] is True
    assert 'background_color' not in body


@pytest.mark.parametrize('kwargs', [
    {'backgroundColor': '#FFFFFF', 'transparentBackground': True},
    {'transparentBackground': False},
])
@patch.dict(os.environ, ENV, clear=False)
def test_contradictory_or_empty_choice_is_rejected_before_any_request(kwargs):
    result, body = _call(load_automation_server(), **kwargs)
    assert '[VALIDATION_ERROR]' in result
    assert body is None
