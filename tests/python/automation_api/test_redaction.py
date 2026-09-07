import os
from unittest.mock import patch

from conftest import load_automation_server

# Automation credentials travel in a form-encoded POST body, so they appear
# percent-encoded wherever requests echoes that body back in error text.
AWKWARD_ID = 'client+id/v1'
AWKWARD_SECRET = 'sec+ret/val=ue'

ENV = {
    'PIXELZ_DOTENV_PATH': '/dev/null',
    'PIXELZ_AUTOMATION_CLIENT_ID': AWKWARD_ID,
    'PIXELZ_AUTOMATION_CLIENT_SECRET': AWKWARD_SECRET,
}


@patch.dict(os.environ, ENV, clear=False)
def test_redacts_percent_encoded_client_secret():
    mod = load_automation_server()
    result = mod.redact_secrets("body: grant_type=client_credentials&client_secret=sec%2Bret%2Fval%3Due")
    assert 'sec%2Bret%2Fval%3Due' not in result
    assert AWKWARD_SECRET not in result
    assert '<REDACTED>' in result


@patch.dict(os.environ, ENV, clear=False)
def test_redacts_percent_encoded_client_id():
    mod = load_automation_server()
    result = mod.redact_secrets("client_id=client%2Bid%2Fv1&x=1")
    assert 'client%2Bid%2Fv1' not in result
    assert AWKWARD_ID not in result


@patch.dict(os.environ, ENV, clear=False)
def test_redacts_raw_values_too():
    mod = load_automation_server()
    result = mod.redact_secrets(f"auth failed for {AWKWARD_ID} / {AWKWARD_SECRET}")
    assert AWKWARD_ID not in result
    assert AWKWARD_SECRET not in result


@patch.dict(os.environ, ENV, clear=False)
def test_param_name_backstop_redacts_unknown_encoding():
    mod = load_automation_server()
    result = mod.redact_secrets("client_id=%63%6c%69&client_secret=%73%65%63")
    assert '%63%6c%69' not in result
    assert '%73%65%63' not in result
    assert result.count('<REDACTED>') == 2


@patch.dict(os.environ, ENV, clear=False)
def test_bearer_token_still_redacted():
    """The JWT pattern must survive the encoding-variant rewrite."""
    mod = load_automation_server()
    jwt = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payloadpart.signaturepart'
    assert jwt not in mod.redact_secrets(f"Authorization: Bearer {jwt}")
