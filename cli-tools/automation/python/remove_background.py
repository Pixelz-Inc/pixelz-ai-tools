import argparse
import requests
import json
import sys
from utils import BASE_URL, get_access_token

def remove_background(image_url):
    try:
        token = get_access_token()
        headers = {
            'Authorization': f'Bearer {token}',
            'Content-Type': 'application/json'
        }
        payload = {
            'image_url': image_url,
            'transparent_background': True
        }
        
        response = requests.post(f"{BASE_URL}/images/remove-background", json=payload, headers=headers)
        response.raise_for_status()
        
        print(json.dumps(response.json(), indent=2))
        
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description='Remove background using Pixelz Automation API')
    parser.add_argument('--url', required=True, help='Image URL')
    args = parser.parse_args()
    
    remove_background(args.url)
