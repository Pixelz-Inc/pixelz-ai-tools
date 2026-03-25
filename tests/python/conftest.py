import os
import sys
import importlib.util

# Project root
PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '../..'))


def load_module_from_file(name, filepath):
    """Load a Python module from a file path, bypassing package structure."""
    spec = importlib.util.spec_from_file_location(name, filepath)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


def load_platform_server():
    """Load the Platform MCP server module."""
    filepath = os.path.join(PROJECT_ROOT, 'mcp-servers', 'platform', 'python', 'server.py')
    return load_module_from_file('platform_server', filepath)


def load_automation_server():
    """Load the Automation MCP server module."""
    filepath = os.path.join(PROJECT_ROOT, 'mcp-servers', 'automation', 'python', 'server.py')
    return load_module_from_file('automation_server', filepath)
