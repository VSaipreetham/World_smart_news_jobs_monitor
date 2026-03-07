import requests
import json

url = "https://openrouter.ai/api/v1/models"

try:
    response = requests.get(url, timeout=10)
    if response.status_code == 200:
        models = response.json()['data']
        # Filter for "free" in id or name, or "qwen"
        print("--- Qwen Models ---")
        for m in models:
            if 'qwen' in m['id'].lower():
                print(m['id'])
        
        print("\n--- Free Models ---")
        for m in models:
            if 'free' in m['id'].lower():
                print(m['id'])
    else:
        print(f"Error: {response.status_code}")
except Exception as e:
    print(f"Exception: {e}")
