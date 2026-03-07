import google.generativeai as genai
import os
from dotenv import load_dotenv

load_dotenv()
key = os.getenv("Google_token")

if not key:
    print("Error: Google_token not found in .env")
    exit()

genai.configure(api_key=key)

print(f"Checking models for key: {key[:5]}...")

try:
    for m in genai.list_models():
        print(f"Model: {m.name}")
        print(f"  Methods: {m.supported_generation_methods}")
except Exception as e:
    print(f"Error listing models: {e}")

print("\nTrying to generate with 'gemini-1.5-flash'...")
try:
    model = genai.GenerativeModel("gemini-2.0-flash")
    response = model.generate_content("Hello")
    print(f"Success! Response: {response.text}")
except Exception as e:
    print(f"Failed: {e}")
