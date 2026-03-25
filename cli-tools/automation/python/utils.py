import os
import sys
import requests
from dotenv import load_dotenv

# Load .env from root
load_dotenv(os.path.abspath(os.path.join(os.path.dirname(__file__), '../../../../.env')))

AUTH_URL = 'https://id.pixelz.com/realms/pixelz-automations/protocol/openid-connect/token'
BASE_URL = 'https://automation-api.pixelz.com/v1'

def get_access_token():
    client_id = os.getenv('PIXELZ_AUTOMATION_CLIENT_ID')
    client_secret = os.getenv('PIXELZ_AUTOMATION_CLIENT_SECRET')

    if not client_id or not client_secret:
        print("Error: Missing PIXELZ_AUTOMATION_CLIENT_ID or PIXELZ_AUTOMATION_CLIENT_SECRET in .env", file=sys.stderr)
        sys.exit(1)

    try:
        data = {
            'grant_type': 'client_credentials',
            'client_id': client_id,
            'client_secret': client_secret
        }
        
        response = requests.post(AUTH_URL, data=data)
        response.raise_for_status()
        return response.json()['access_token']
        
    except Exception as e:
        print(f"Authentication failed: {e}", file=sys.stderr)
        sys.exit(1)
