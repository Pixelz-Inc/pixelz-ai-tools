import json
import requests
from utils import BASE_URL, get_access_token

def get_webhook_public_key():
    token = get_access_token()
    headers = {'Authorization': f'Bearer {token}'}
    
    try:
        response = requests.get(f"{BASE_URL}/webhook/public-keys", headers=headers)
        response.raise_for_status()
        print(json.dumps(response.json(), indent=2))
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    get_webhook_public_key()
