import os
import sys
import json
from dotenv import load_dotenv

# Load .env from root
load_dotenv(os.path.abspath(os.path.join(os.path.dirname(__file__), '../../../../.env')))

BASE_URL = 'https://api.pixelz.com/REST.svc/JSON'

def get_auth_params():
    email = os.getenv('PIXELZ_PLATFORM_EMAIL')
    api_key = os.getenv('PIXELZ_PLATFORM_API_KEY')
    
    if not email or not api_key:
        print("Error: Missing PIXELZ_PLATFORM_EMAIL or PIXELZ_PLATFORM_API_KEY in .env", file=sys.stderr)
        sys.exit(1)
        
    return {'contactEmail': email, 'contactAPIkey': api_key}
