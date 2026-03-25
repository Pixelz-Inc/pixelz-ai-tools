import argparse
import requests
import json
import sys
from utils import BASE_URL, get_auth_params

def upload_image(image_url, template_id):
    try:
        auth = get_auth_params()
        payload = auth.copy()
        payload.update({
            'templateId': template_id,
            'imageURL': image_url
        })
        
        response = requests.post(f"{BASE_URL}/Image", json=payload)
        response.raise_for_status()
        
        print(json.dumps(response.json(), indent=2))
        
    except Exception as e:
        print(f"Error uploading image: {e}", file=sys.stderr)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description='Upload image to Pixelz Platform API')
    parser.add_argument('--url', required=True, help='Image URL')
    parser.add_argument('--template', required=True, help='Template ID')
    args = parser.parse_args()
    
    upload_image(args.url, args.template)
