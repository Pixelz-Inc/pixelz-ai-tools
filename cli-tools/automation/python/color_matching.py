import sys
import json
import requests
from utils import BASE_URL, get_access_token

def color_matching():
    if len(sys.argv) < 3:
        print('Usage: python color_matching.py <imageUrl> <colorMarkersJSON>')
        sys.exit(1)

    image_url = sys.argv[1]
    try:
        color_markers = json.loads(sys.argv[2])
    except Exception as e:
        print(f"Error parsing JSON: {e}")
        sys.exit(1)

    token = get_access_token()
    headers = {'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'}
    payload = {'image_url': image_url, 'color_markers': color_markers}
    
    try:
        response = requests.post(f"{BASE_URL}/images/color-matching", json=payload, headers=headers)
        response.raise_for_status()
        print(json.dumps(response.json(), indent=2))
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    color_matching()
