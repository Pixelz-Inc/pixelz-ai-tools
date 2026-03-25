import sys
import json
import requests
from utils import BASE_URL, get_access_token

def create_trimap():
    if len(sys.argv) < 2:
        print('Usage: python create_trimap.py <imageUrl>')
        sys.exit(1)

    image_url = sys.argv[1]

    token = get_access_token()
    headers = {'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'}
    payload = {'image_url': image_url}
    
    try:
        response = requests.post(f"{BASE_URL}/images/create-trimap", json=payload, headers=headers)
        response.raise_for_status()
        print(json.dumps(response.json(), indent=2))
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    create_trimap()
