import sys
import json
import requests
from utils import BASE_URL, get_access_token

def request_upload_url():
    if len(sys.argv) < 2:
        print('Usage: python request_upload_url.py <fileName>')
        sys.exit(1)

    file_name = sys.argv[1]

    token = get_access_token()
    headers = {'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'}
    payload = {'fileName': file_name}
    
    try:
        response = requests.post(f"{BASE_URL}/files/request-upload-url", json=payload, headers=headers)
        response.raise_for_status()
        print(json.dumps(response.json(), indent=2))
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    request_upload_url()
