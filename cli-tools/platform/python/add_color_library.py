import argparse
import requests
import json
import sys
from utils import BASE_URL, get_auth_params

def add_color_library(image_urls):
    try:
        auth = get_auth_params()
        payload = auth.copy()
        payload['imagesUrl'] = image_urls

        response = requests.post(f"{BASE_URL}/AddColorLibrary", json=payload)
        response.raise_for_status()

        print(json.dumps(response.json(), indent=2))

    except Exception as e:
        print(f"Error adding color library: {e}", file=sys.stderr)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description='Register color swatches with Pixelz Platform API')
    parser.add_argument('urls', nargs='+', help='One or more swatch image URLs')
    args = parser.parse_args()

    add_color_library(args.urls)
