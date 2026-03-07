import os
import json
import google.generativeai as genai

genai.configure(api_key=os.getenv("Google_token"))

def generate_insights_and_videos(headlines: list, jobs: list):
    """
    Uses Gemini to comprehend the latest news & job drops from the database,
    providing structured context and actual YouTube queries.
    """
    news_text = " | ".join(headlines[:15])
    job_text = " | ".join([f"{j['company_or_source']} hiring {j['title']}" for j in jobs[:10]])
    
    prompt = f"""You are a Silicon Valley Intelligence Analyst. 
Analyze these latest global news items: {news_text}
And these latest tech job movements: {job_text}

Provide:
1. "summary_news": A bold 3-sentence summary regarding tech trends, company launches, or geopolitical impacts.
2. "summary_jobs": A 2-sentence summary detailing who is hiring heavily right now.
3. "video_queries": An array of precisely 3 YouTube search phrases. Ensure these directly tie to the most striking news items provided (e.g. if 'Apple releases vision pro' is in the news, you must output 'Apple Vision Pro review' or similar).

Return pure JSON:
{{
  "summary_news": "...",
  "summary_jobs": "...",
  "video_queries": ["query1", "query2", "query3"]
}}
"""
    try:
        model = genai.GenerativeModel('gemini-1.5-flash', generation_config={"response_mime_type": "application/json"})
        resp = model.generate_content(prompt)
        return json.loads(resp.text)
    except Exception as e:
        print("Gemini Error:", e)
        return {
            "summary_news": "Global data aggregated successfully. Current streams prioritize infrastructure shifts.",
            "summary_jobs": "Tech sectors actively hiring in major global hubs.",
            "video_queries": ["Tech News Today", "AI Developments 2024", "Silicon Valley Updates"]
        }
