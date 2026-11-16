"""Behaviour of the shared module and both Python MCP servers; each rule has a Node twin in tests/node."""
import asyncio
import json
import os
import sys
from unittest.mock import MagicMock, patch

import pytest
import requests

from conftest import PROJECT_ROOT, load_automation_server, load_platform_server

sys.path.insert(0, os.path.join(PROJECT_ROOT, 'shared', 'python'))
import pixelz_common  # noqa: E402

PLATFORM_ENV = {'PIXELZ_DOTENV_PATH': '/dev/null', 'PIXELZ_PLATFORM_EMAIL': 'test@example.com', 'PIXELZ_PLATFORM_API_KEY': 'key123'}
AUTOMATION_ENV = {'PIXELZ_DOTENV_PATH': '/dev/null', 'PIXELZ_AUTOMATION_CLIENT_ID': 'client123', 'PIXELZ_AUTOMATION_CLIENT_SECRET': 'secret456'}
IMG = 'https://example.com/shirt.jpg'


def _ok(body):
    r = MagicMock(status_code=200)
    r.json.return_value = body
    return r


def _err(status, body=None):
    r = MagicMock(status_code=status)
    r.json.return_value = body or {}
    r.raise_for_status.side_effect = requests.exceptions.HTTPError(f'{status} Error', response=r)
    return r


def _tool(fn, *args, **kwargs):
    """Run a tool and return its result, or the ToolError text (what the agent sees)."""
    try:
        return fn(*args, **kwargs)
    except Exception as e:  # ToolError carries the categorized message
        return str(e)


# --- shared module -----------------------------------------------------------------------------

def test_upload_allowlists():
    assert pixelz_common.AUTOMATION_MIME_TYPES == {'.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp'}
    assert pixelz_common.AUTOMATION_UPLOAD_EXTENSIONS == ('.jpg', '.jpeg', '.png', '.webp')
    assert '.psd' in pixelz_common.PLATFORM_UPLOAD_EXTENSIONS and '.rw2' in pixelz_common.PLATFORM_UPLOAD_EXTENSIONS


@pytest.mark.parametrize('value', [None, '', 123, ['a']])
def test_validate_id_requires_a_non_empty_string(value):
    with pytest.raises(ValueError, match=r'^\[VALIDATION_ERROR\] jobId is required$'):
        pixelz_common.validate_id(value, 'jobId')


def test_validate_id_message_is_categorized():
    with pytest.raises(ValueError, match=r'^\[VALIDATION_ERROR\] Invalid jobId: contains unexpected characters$'):
        pixelz_common.validate_id('a/b', 'jobId')
    with pytest.raises(ValueError):
        pixelz_common.validate_id('abc\n', 'jobId')


def test_resolve_local_file_rejects_other_file_types_case_insensitively(tmp_path):
    secret = tmp_path / '.env'
    secret.write_text('KEY=1')
    with pytest.raises(Exception, match=r'^\[VALIDATION_ERROR\] Unsupported file type "" for upload\. Allowed: \.jpg, \.jpeg, \.png, \.webp\.$'):
        pixelz_common.resolve_local_file(str(secret), pixelz_common.AUTOMATION_UPLOAD_EXTENSIONS)
    key = tmp_path / 'id_rsa.PEM'
    key.write_text('x')
    with pytest.raises(Exception, match=r'Unsupported file type "\.pem"'):
        pixelz_common.resolve_local_file(str(key), pixelz_common.PLATFORM_UPLOAD_EXTENSIONS)
    photo = tmp_path / 'SHIRT.JPG'
    photo.write_bytes(b'x')
    assert pixelz_common.resolve_local_file(str(photo), pixelz_common.AUTOMATION_UPLOAD_EXTENSIONS)[1] == 1


def test_resolve_local_file_escape_hatch(tmp_path):
    odd = tmp_path / 'scan.xyz'
    odd.write_bytes(b'x')
    with patch.dict(os.environ, {'PIXELZ_UPLOAD_ANY_FILE_TYPE': 'true'}):
        assert pixelz_common.resolve_local_file(str(odd), pixelz_common.PLATFORM_UPLOAD_EXTENSIONS)[1] == 1
    with patch.dict(os.environ, {'PIXELZ_UPLOAD_ANY_FILE_TYPE': '1'}), pytest.raises(Exception, match='Unsupported file type'):
        pixelz_common.resolve_local_file(str(odd), pixelz_common.PLATFORM_UPLOAD_EXTENSIONS)


def test_resolve_local_file_errors_are_categorized(tmp_path):
    exts = pixelz_common.PLATFORM_UPLOAD_EXTENSIONS
    with pytest.raises(Exception, match=r'^\[VALIDATION_ERROR\] Local file not found: '):
        pixelz_common.resolve_local_file(str(tmp_path / 'missing.jpg'), exts)
    with pytest.raises(Exception, match=r'^\[VALIDATION_ERROR\] Not a regular file: '):
        pixelz_common.resolve_local_file(str(tmp_path), exts)
    big = tmp_path / 'big.jpg'
    big.write_bytes(b'x')
    with patch.object(pixelz_common, 'MAX_FILE_SIZE', 0), pytest.raises(Exception, match=r'^\[VALIDATION_ERROR\] File too large'):
        pixelz_common.resolve_local_file(str(big), exts)


def test_a_failed_log_write_does_not_raise_into_the_tool_call(tmp_path, capsys):
    # A directory as the log file makes open(..., 'a') fail.
    with patch.dict(os.environ, {'PIXELZ_LOG_FILE': str(tmp_path)}):
        log = pixelz_common.make_logger(lambda s: s)
    log('info', 'hello', {'a': 1})
    assert 'Log write failed:' in capsys.readouterr().err


# --- _format_error ----------------------------------------------------------------------------

@pytest.mark.parametrize('loader,env', [(load_platform_server, PLATFORM_ENV), (load_automation_server, AUTOMATION_ENV)])
def test_format_error_does_not_double_prefix_categorized_value_errors(loader, env):
    with patch.dict(os.environ, env, clear=False):
        mod = loader()
        assert mod._format_error('t', ValueError('[VALIDATION_ERROR] jobId is required')) == '[VALIDATION_ERROR] jobId is required'
        assert mod._format_error('t', ValueError('[AUTH_ERROR] nope')) == '[AUTH_ERROR] nope'
        assert mod._format_error('t', ValueError('plain')) == '[VALIDATION_ERROR] plain'


# --- Automation -------------------------------------------------------------------------------

@patch.dict(os.environ, AUTOMATION_ENV, clear=False)
def test_automation_upload_rejects_non_images_before_any_request(tmp_path):
    mod = load_automation_server()
    secret = tmp_path / 'credentials.txt'
    secret.write_text('x')
    with patch.object(mod._session, 'post') as post, pytest.raises(Exception, match='Unsupported file type ".txt"'):
        mod.ensure_url_or_id(str(secret), 'tok')
    post.assert_not_called()


@patch.dict(os.environ, AUTOMATION_ENV, clear=False)
def test_automation_upload_403_means_uploads_are_not_enabled(tmp_path):
    mod = load_automation_server()
    img = tmp_path / 'a.png'
    img.write_bytes(b'x')
    with patch.object(mod._session, 'post', return_value=_err(403)), pytest.raises(Exception) as exc:
        mod.ensure_url_or_id(str(img), 'tok')
    assert str(exc.value) == ('[UPLOAD_UNAVAILABLE] HTTP 403: the account may not be enabled for direct file uploads '
                              '(off by default on the Automation API). Provide a publicly accessible image URL instead of a local file path.')
    # And the tool reports it unchanged, with no second prefix.
    with patch.object(mod, 'get_token', return_value='tok'), patch.object(mod._session, 'post', return_value=_err(403)):
        assert _tool(mod.create_trimap, imagePath=str(img)).startswith('[UPLOAD_UNAVAILABLE] HTTP 403')


@pytest.mark.parametrize('name,content_type', [('a.PNG', 'image/png'), ('b.jpg', 'image/jpeg'), ('c.jpeg', 'image/jpeg'), ('d.webp', 'image/webp')])
@patch.dict(os.environ, AUTOMATION_ENV, clear=False)
def test_automation_upload_content_type_comes_from_the_shared_table(tmp_path, name, content_type):
    mod = load_automation_server()
    img = tmp_path / name
    img.write_bytes(b'x')
    with patch.object(mod._session, 'post', return_value=_ok({'url': 'https://s3.example/put'})), \
         patch.object(mod._session, 'put', return_value=_ok({})) as put, \
         patch('mimetypes.guess_type', side_effect=AssertionError('registry-dependent')):
        assert mod.ensure_url_or_id(str(img), 'tok') == 'https://s3.example/put'
    assert put.call_args.kwargs['headers'] == {'Content-Type': content_type}


@patch.dict(os.environ, AUTOMATION_ENV, clear=False)
def test_model_crop_needs_at_least_one_location():
    mod = load_automation_server()
    with patch.object(mod, 'get_token', side_effect=AssertionError('no token before validation')):
        assert _tool(mod.model_crop, imagePath=IMG) == '[VALIDATION_ERROR] at least one of topCropLocation or bottomCropLocation is required'
        assert 'topCropLocation: must be one of' in _tool(mod.model_crop, imagePath=IMG, topCropLocation='head')
    with patch.object(mod, 'get_token', return_value='tok'), patch.object(mod._session, 'post', return_value=_ok({'job_id': 'j'})) as post:
        mod.model_crop(imagePath=IMG, bottomCropLocation='waist')
    assert post.call_args.kwargs['json'] == {'image_url': IMG, 'bottom_crop_location': 'waist'}


GOOD_COLOR = {'x_coordinate': 1, 'y_coordinate': 2, 'swatch_color_code': '#FF00AA'}
GOOD_SWATCH = {'x_coordinate': 1, 'y_coordinate': 2, 'swatch_image': {'swatch_image_url': 'https://e.com/s.jpg', 'x_coordinate': 3, 'y_coordinate': 4}}


@pytest.mark.parametrize('markers,fragment', [
    ([], 'non-empty array'),
    (['x'], 'must be an object'),
    ([{'y_coordinate': 2, 'swatch_color_code': '#FF00AA'}], 'colorMarkers.0.x_coordinate: must be an integer'),
    ([{**GOOD_COLOR, 'x_coordinate': 1.5}], 'x_coordinate: must be an integer'),
    ([{**GOOD_COLOR, 'y_coordinate': True}], 'y_coordinate: must be an integer'),
    ([{'x_coordinate': 1, 'y_coordinate': 2}], 'exactly one of swatch_color_code or swatch_image'),
    ([{**GOOD_COLOR, 'swatch_image': GOOD_SWATCH['swatch_image']}], 'exactly one of swatch_color_code or swatch_image'),
    ([{**GOOD_COLOR, 'swatch_color_code': 'red'}], 'swatch_color_code: must be a hex color'),
    ([{**GOOD_COLOR, 'extra': 1}], 'unrecognized key "extra"'),
    ([{**GOOD_SWATCH, 'swatch_image': {'swatch_image_url': 'u', 'x_coordinate': 3}}], 'swatch_image.y_coordinate: must be an integer'),
    ([{**GOOD_SWATCH, 'swatch_image': {'x_coordinate': 3, 'y_coordinate': 4}}], 'swatch_image_url: must be a non-empty string'),
    ([GOOD_COLOR, {**GOOD_SWATCH, 'x_coordinate': 'a'}], 'colorMarkers.1.x_coordinate'),
])
@patch.dict(os.environ, AUTOMATION_ENV, clear=False)
def test_color_markers_are_validated_before_any_request(markers, fragment):
    mod = load_automation_server()
    with patch.object(mod, 'get_token', side_effect=AssertionError('no token before validation')):
        result = _tool(mod.color_matching, imagePath=IMG, colorMarkers=markers)
    assert result.startswith('[VALIDATION_ERROR] ') and fragment in result


@patch.dict(os.environ, AUTOMATION_ENV, clear=False)
def test_valid_color_markers_are_sent_unchanged_and_the_schema_advertises_their_shape():
    mod = load_automation_server()
    markers = [GOOD_COLOR, GOOD_SWATCH, {**GOOD_SWATCH, 'swatch_color_code': None}]
    with patch.object(mod, 'get_token', return_value='tok'), patch.object(mod._session, 'post', return_value=_ok({'job_id': 'j'})) as post:
        mod.color_matching(imagePath=IMG, colorMarkers=markers)
    assert post.call_args.kwargs['json']['color_markers'] == markers
    schema = next(t for t in asyncio.run(mod.mcp.list_tools()) if t.name == 'color_matching').input_schema
    items = schema['properties']['colorMarkers']['items']
    assert sorted(items['properties']) == ['swatch_color_code', 'swatch_image', 'x_coordinate', 'y_coordinate']
    assert items['required'] == ['x_coordinate', 'y_coordinate']
    assert items['properties']['x_coordinate']['type'] == 'integer'
    assert schema['properties']['colorMarkers']['minItems'] == 1


@patch.dict(os.environ, AUTOMATION_ENV, clear=False)
def test_automation_get_job_status_requires_a_job_id():
    mod = load_automation_server()
    assert _tool(mod.get_job_status, jobId=None) == '[VALIDATION_ERROR] jobId is required'


# --- Platform ---------------------------------------------------------------------------------

@patch.dict(os.environ, PLATFORM_ENV, clear=False)
def test_platform_upload_rejects_non_images_before_any_request(tmp_path):
    mod = load_platform_server()
    secret = tmp_path / 'id_rsa'
    secret.write_text('x')
    with patch.object(mod._session, 'post') as post, pytest.raises(Exception, match='Unsupported file type ""'):
        mod.ensure_url(str(secret))
    post.assert_not_called()


@pytest.mark.parametrize('kwargs,fragment', [
    ({'swatchColorCode': 'red'}, 'swatchColorCode: must be a hex color'),
    ({'swatchColorCode': '#FFF'}, 'swatchColorCode: must be a hex color'),
])
@patch.dict(os.environ, PLATFORM_ENV, clear=False)
def test_platform_upload_validates_the_swatch_color(kwargs, fragment):
    mod = load_platform_server()
    result = _tool(mod.upload_image, imagePath=IMG, templateId='1', **kwargs)
    assert result.startswith('[VALIDATION_ERROR] ') and fragment in result


@pytest.mark.parametrize('kwargs,fragment', [
    ({'imagesPerPage': 101}, 'imagesPerPage: must be <= 100'),
    ({'sortBy': 'name'}, 'sortBy: must be one of id, date, status'),
    ({'isDescending': 'yes'}, 'isDescending: must be one of true, false'),
])
@patch.dict(os.environ, PLATFORM_ENV, clear=False)
def test_list_images_validation_matches_node(kwargs, fragment):
    mod = load_platform_server()
    with patch.object(mod._session, 'get') as get:
        result = _tool(mod.list_images, **kwargs)
    assert result.startswith('[VALIDATION_ERROR] ') and fragment in result
    get.assert_not_called()


@patch.dict(os.environ, PLATFORM_ENV, clear=False)
def test_paging_parameters_are_omitted_unless_given():
    mod = load_platform_server()
    with patch.object(mod._session, 'get', return_value=_ok({'ErrorCode': 'NoError'})) as get:
        mod.list_images()
        assert set(get.call_args.kwargs['params']) == {'contactEmail', 'contactAPIkey'}
        mod.list_images(page=2, imagesPerPage=100, sortBy='date', isDescending='false', imageStatus='delivered')
        p = get.call_args.kwargs['params']
        assert (p['page'], p['imagesPerPage'], p['sortBy'], p['isDescending'], p['imageStatus']) == (2, 100, 'date', 'false', '80')
        mod.list_product_ids()
        assert set(get.call_args.kwargs['params']) == {'contactEmail', 'contactAPIkey'}
        mod.list_product_ids(page=3, perPage=5)
        assert (get.call_args.kwargs['params']['page'], get.call_args.kwargs['params']['productIdsPerPage']) == (3, 5)
        mod.get_invoices()
        assert 'page' not in get.call_args.kwargs['params']


@patch.dict(os.environ, PLATFORM_ENV, clear=False)
def test_reject_image_sends_the_documented_body():
    mod = load_platform_server()
    with patch.object(mod._session, 'put', return_value=_ok({'ErrorCode': 'NoError'})) as put:
        mod.reject_image(imageTicket='T-1', comment='fix it', markupImageUrl='https://e.com/m.png', customerImageId='c1')
    assert put.call_args.kwargs['json'] == {
        'contactEmail': 'test@example.com', 'contactAPIkey': 'key123', 'imageTicket': 'T-1',
        'comment': 'fix it', 'markupImageUrl': 'https://e.com/m.png', 'customerImageId': 'c1',
    }


@patch.dict(os.environ, PLATFORM_ENV, clear=False)
def test_platform_schema_advertises_the_enums_and_limits():
    mod = load_platform_server()
    props = next(t for t in asyncio.run(mod.mcp.list_tools()) if t.name == 'list_images').input_schema['properties']
    assert props['sortBy']['enum'] == ['id', 'date', 'status']
    assert props['isDescending']['enum'] == ['true', 'false']
    assert props['imagesPerPage']['maximum'] == 100


@patch.dict(os.environ, PLATFORM_ENV, clear=False)
def test_platform_get_image_status_requires_a_ticket():
    mod = load_platform_server()
    assert _tool(mod.get_image_status, imageTicket=None).startswith('[VALIDATION_ERROR] ')


# --- Metadata ---------------------------------------------------------------------------------

def _annotations(mod):
    return {t.name: t.annotations.model_dump(by_alias=True, exclude_none=True) for t in asyncio.run(mod.mcp.list_tools())}


@patch.dict(os.environ, {**PLATFORM_ENV, **AUTOMATION_ENV}, clear=False)
def test_tool_annotations():
    platform = _annotations(load_platform_server())
    for name in ('list_templates', 'get_template_detail', 'get_image_status', 'list_images', 'count_images', 'list_product_ids', 'get_contact', 'get_invoices'):
        assert platform[name] == {'readOnlyHint': True, 'openWorldHint': True}, name
    assert platform['delete_image']['destructiveHint'] is True and platform['delete_image']['readOnlyHint'] is False
    for name in ('upload_image', 'white_glove_service', 'stack_image'):
        assert platform[name] == {'readOnlyHint': False, 'destructiveHint': False, 'idempotentHint': False, 'openWorldHint': True}, name
    automation = _annotations(load_automation_server())
    for name in ('remove_background', 'color_matching', 'create_mask', 'create_trimap', 'model_crop'):
        assert automation[name] == {'readOnlyHint': False, 'destructiveHint': False, 'idempotentHint': False, 'openWorldHint': True}, name
    assert automation['get_job_status'] == automation['get_webhook_public_key'] == {'readOnlyHint': True, 'openWorldHint': True}


@patch.dict(os.environ, {**PLATFORM_ENV, **AUTOMATION_ENV}, clear=False)
def test_server_identity_and_version_come_from_the_root_package_json():
    version = json.load(open(os.path.join(PROJECT_ROOT, 'package.json'), encoding='utf-8'))['version']
    platform, automation = load_platform_server(), load_automation_server()
    assert platform.mcp.name == 'pixelz-platform-mcp'
    assert automation.mcp.name == 'pixelz-automation-mcp'
    assert platform._read_repo_version() == automation._read_repo_version() == version
    assert platform.mcp._lowlevel_server.version == automation.mcp._lowlevel_server.version == version


@patch.dict(os.environ, {**PLATFORM_ENV, **AUTOMATION_ENV}, clear=False)
def test_descriptions_carry_status_codes_and_cost():
    platform = {t.name: t.description for t in asyncio.run(load_platform_server().mcp.list_tools())}
    for code in ('12 download failed', '90 rejected by Pixelz', '95 awaiting your reply', 'FinalImagesURL'):
        assert code in platform['get_image_status']
    assert 'any numeric code' in platform['list_images'] and 'any numeric code' in platform['count_images']
    for name in ('upload_image', 'white_glove_service', 'stack_image'):
        assert 'billable' in platform[name], name
    automation = {t.name: t.description for t in asyncio.run(load_automation_server().mcp.list_tools())}
    for name, cost in (('remove_background', '100'), ('color_matching', '100'), ('create_mask', '100'), ('create_trimap', '50'), ('model_crop', '10')):
        assert f'Billed: {cost} tokens' in automation[name], name
    assert 'At least one of topCropLocation' in automation['model_crop']


@patch.dict(os.environ, {**PLATFORM_ENV, 'PIXELZ_LOG_FILE': ''}, clear=False)
def test_logging_records_identifiers_only(tmp_path):
    log_file = tmp_path / 'pixelz.log'
    with patch.dict(os.environ, {'PIXELZ_LOG_FILE': str(log_file)}):
        mod = load_platform_server()
        with patch.object(mod._session, 'put', return_value=_ok({'ErrorCode': 'NoError'})):
            mod.reject_image(imageTicket='T-1', comment='SECRET-COMMENT', markupImageUrl='https://private.example/m.png')
    text = log_file.read_text()
    assert 'T-1' in text and 'SECRET-COMMENT' not in text and 'private.example' not in text
