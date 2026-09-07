import os
from unittest.mock import patch

from conftest import load_platform_server

# A base64-shaped key: + / = are all percent-encoded inside a URL, which is what defeated
# the original literal-match redactor and leaked the key into agent-visible error text.
AWKWARD_KEY = 'ab+cd/ef=gh'
AWKWARD_EMAIL = 'leaky@example.com'

ENV = {
    'PIXELZ_DOTENV_PATH': '/dev/null',
    'PIXELZ_PLATFORM_EMAIL': AWKWARD_EMAIL,
    'PIXELZ_PLATFORM_API_KEY': AWKWARD_KEY,
}


@patch.dict(os.environ, ENV, clear=False)
def test_redacts_percent_encoded_api_key():
    """The pre-fix redactor matched only the raw value, so this exact string leaked."""
    mod = load_platform_server()
    url = "https://api.pixelz.com/REST.svc/JSON/Contact?contactAPIkey=ab%2Bcd%2Fef%3Dgh"
    result = mod.redact_secrets(f"Max retries exceeded with url: {url}")
    assert 'ab%2Bcd%2Fef%3Dgh' not in result
    assert AWKWARD_KEY not in result
    assert '<REDACTED>' in result


@patch.dict(os.environ, ENV, clear=False)
def test_redacts_percent_encoded_email():
    mod = load_platform_server()
    result = mod.redact_secrets("contactEmail=leaky%40example.com&foo=1")
    assert 'leaky%40example.com' not in result
    assert AWKWARD_EMAIL not in result


@patch.dict(os.environ, ENV, clear=False)
def test_redacts_raw_values_too():
    """The encoded-form fix must not regress the original raw-value behavior."""
    mod = load_platform_server()
    result = mod.redact_secrets(f"Auth failed for {AWKWARD_EMAIL} with key {AWKWARD_KEY}")
    assert AWKWARD_KEY not in result
    assert AWKWARD_EMAIL not in result


@patch.dict(os.environ, ENV, clear=False)
def test_param_name_backstop_redacts_unknown_encoding():
    """
    The value-matching passes cannot anticipate every encoding, so redaction also strips
    anything sitting in the credential query params regardless of how it is encoded.
    """
    mod = load_platform_server()
    result = mod.redact_secrets("?contactAPIkey=%61%62%2B%63%64&contactEmail=%6c%65%61%6b%79")
    assert '%61%62%2B%63%64' not in result
    assert '%6c%65%61%6b%79' not in result
    assert result.count('<REDACTED>') == 2


@patch.dict(os.environ, {**ENV, 'PIXELZ_PLATFORM_API_KEY': ''}, clear=False)
def test_missing_credential_does_not_redact_everything():
    """An empty credential must not turn into a match-everything replacement."""
    mod = load_platform_server()
    result = mod.redact_secrets("nothing sensitive here")
    assert result == "nothing sensitive here"
