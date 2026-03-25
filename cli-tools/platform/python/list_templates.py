import requests
import json
from utils import BASE_URL, get_auth_params

def list_templates():
    try:
        params = get_auth_params()
        response = requests.get(f"{BASE_URL}/Templates", params=params)
        response.raise_for_status()
        
        data = response.json()
        if 'Templates' in data:
            print(json.dumps(data['Templates'], indent=2))
        else:
            print("No templates found or error in response.")
            print(data)
            
    except Exception as e:
        print(f"Error fetching templates: {e}", file=sys.stderr)

if __name__ == "__main__":
    list_templates()
