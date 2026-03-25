import argparse
import requests
import json
import sys
from utils import BASE_URL, get_access_token

def get_status(job_id):
    try:
        token = get_access_token()
        headers = {
            'Authorization': f'Bearer {token}'
        }
        
        response = requests.get(f"{BASE_URL}/images/jobs/{job_id}/status", headers=headers)
        response.raise_for_status()
        
        print(json.dumps(response.json(), indent=2))
        
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description='Get Job Status from Pixelz Automation API')
    parser.add_argument('--job', required=True, help='Job ID')
    args = parser.parse_args()
    
    get_status(args.job)
