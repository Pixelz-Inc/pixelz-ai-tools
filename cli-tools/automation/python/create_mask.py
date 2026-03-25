import sys
import json
import requests
from utils import BASE_URL, get_access_token

def create_mask():
    if len(sys.argv) < 2:
        print('Usage: python create_mask.py <imageUrl> [featherWidth] [trimapUrl]')
        sys.exit(1)

    image_url = sys.argv[1]
    feather_width = float(sys.argv[2]) if len(sys.argv) > 2 else None
    trimap_url = sys.argv[3] if len(sys.argv) > 3 else None

    token = get_access_token()
    headers = {'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'}
    payload = {'image_url': image_url}
    if feather_width is not None: payload['feather_width'] = feather_width
    if trimap_url: payload['trimap_url'] = trimap_url
    
    try:
        response = requests.post(f"{BASE_URL}/images/create-mask", json=payload, headers=headers)
        response.raise_for_status()
        print(json.dumps(response.json(), indent=2))
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    create_mask()
