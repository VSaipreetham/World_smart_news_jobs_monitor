import os
import requests
import json
from dotenv import load_dotenv

load_dotenv()

# Try to get the key as the app would
key = os.getenv("Gemma3b_token")

print(f"Key found: {key[:10]}..." if key else "No key found")

if not key:
    exit()

url = "https://openrouter.ai/api/v1/chat/completions"
headers = {
    "Authorization": f"Bearer {key}",
    "Content-Type": "application/json",
    "HTTP-Referer": "http://localhost:8501", 
    "X-Title": "Smart Job Portal Test",
}
# The app tries "google/gemma-3-27b-it:free"
data = {
    "model": "google/gemma-3-27b-it:free",
    "messages": [{"role": "user", "content": "Hello"}]
}

print(f"Testing model: {data['model']}")
try:
    response = requests.post(url, headers=headers, data=json.dumps(data), timeout=20)
    print(f"Status: {response.status_code}")
    if response.status_code == 200:
        print(f"Response: {response.json()['choices'][0]['message']['content']}")
    else:
        print(f"Error: {response.text}")
except Exception as e:
    print(f"Exception: {e}")
