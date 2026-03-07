import google.generativeai as genai
import os
from dotenv import load_dotenv

load_dotenv()
key = os.getenv("Google_token")
genai.configure(api_key=key)

print(f"Checking GEMINI models for key: {key[:5]}...")

try:
    found = False
    for m in genai.list_models():
        if 'gemini' in m.name:
            print(f"Model: {m.name} | Methods: {m.supported_generation_methods}")
            if 'generateContent' in m.supported_generation_methods:
                found = True
    
    if not found:
        print("NO models found with 'gemini' and 'generateContent'. Listing ALL generateContent models:")
        for m in genai.list_models():
             if 'generateContent' in m.supported_generation_methods:
                print(f"Model: {m.name}")

except Exception as e:
    print(f"Error listing models: {e}")
