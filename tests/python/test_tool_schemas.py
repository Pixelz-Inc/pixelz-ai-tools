"""What the Python MCP servers advertise to agents, checked against what the Node servers advertise.

The Python track used to have no parameter descriptions at all (agents lost the hints Node gives:
date formats, hex colours, page limits), lacked parameters Node has, and typed markerX/markerY as
floats where the API documents integers.
"""
import asyncio
import os
from unittest.mock import patch

from conftest import load_automation_server, load_platform_server

ENV = {'PIXELZ_DOTENV_PATH': '/dev/null'}


def _schemas(mod):
    return {t.name: t.input_schema['properties'] for t in asyncio.run(mod.mcp.list_tools())}


@patch.dict(os.environ, ENV, clear=False)
def test_platform_tools_have_the_parameters_node_has():
    s = _schemas(load_platform_server())
    assert 'customerImageId' in s['delete_image']
    assert 'customerFolder' in s['stack_image']
    for p in ('imageURL2', 'imageURL5', 'colorReferenceFileURL'):
        assert p in s['white_glove_service']
    assert s['upload_image']['markerX']['type'] == 'integer'


@patch.dict(os.environ, ENV, clear=False)
def test_parameter_descriptions_reach_the_agent():
    platform = _schemas(load_platform_server())
    assert 'yyyy-MM-dd' in platform['upload_image']['imageDeadlineDateTimeUTC']['description']
    assert 'list_templates' in platform['upload_image']['templateId']['description']
    automation = _schemas(load_automation_server())
    assert 'description' in automation['remove_background']['backgroundColor']
