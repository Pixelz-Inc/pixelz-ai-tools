"""Print each Python MCP server's advertised tool list as JSON, for the Node parity test.

The Node test (tests/node/toolParity.test.ts) spawns this and compares the result with the
Node servers' TOOLS, so any drift in names, properties, required, enums or annotations fails CI.
"""
import asyncio
import json
import os
import sys

# Never load the repo's real .env while introspecting.
os.environ['PIXELZ_DOTENV_PATH'] = os.devnull
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from conftest import load_automation_server, load_platform_server  # noqa: E402


def summarize(mod):
    tools = []
    for t in asyncio.run(mod.mcp.list_tools()):
        props = t.input_schema.get('properties', {})
        annotations = t.annotations.model_dump(by_alias=True, exclude_none=True) if t.annotations else {}
        tools.append({
            'name': t.name,
            'properties': sorted(props),
            'required': sorted(t.input_schema.get('required', [])),
            'enums': {k: v['enum'] for k, v in sorted(props.items()) if 'enum' in v},
            'annotations': annotations,
        })
    return sorted(tools, key=lambda t: t['name'])


if __name__ == '__main__':
    print(json.dumps({'platform': summarize(load_platform_server()), 'automation': summarize(load_automation_server())}))
