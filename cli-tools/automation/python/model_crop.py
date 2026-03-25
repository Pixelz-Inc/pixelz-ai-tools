import sys
import json
import requests
from utils import BASE_URL, get_access_token

def model_crop():
    if len(sys.argv) < 2:
        print('Usage: python model_crop.py <imageUrl> [topCrop] [bottomCrop]')
        sys.exit(1)

    image_url = sys.argv[1]
    top_crop = sys.argv[2] if len(sys.argv) > 2 else None
    bottom_crop = sys.argv[3] if len(sys.argv) > 3 else None

    token = get_access_token()
    headers = {'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'}
    payload = {'image_url': image_url}
    if top_crop: payload['top_crop_location'] = top_crop
    if bottom_crop: payload['bottom_crop_location'] = bottom_crop
    
    try:
        response = requests.post(f"{BASE_URL}/images/model-crop", json=payload, headers=headers)
        response.raise_for_status()
        print(json.dumps(response.json(), indent=2))
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    model_crop()
