# AI Career Companion Setup

To enable the AI features:

1.  **Get your Gemini API Key** from [Google AI Studio](https://aistudio.google.com/).
    *(Note: Using `gemini-1.5-pro` model)*

2.  **Add the key to your `.env` file**:
    Open the file named `.env` in this directory and add the following line:
    ```env
    Google_token=YOUR_API_KEY_HERE
    ```

3.  **Install dependencies**:
    ```bash
    pip install -r requirements.txt
    ```

4.  **Run the app**:
    ```bash
    streamlit run app.py
    ```

The AI Career Companion will appear in the "🤖 AI Career Coach" tab. Upload your resume (PDF) and start chatting!
    
5. **Explore AI Analytics (New!)**:
    Go to the **"📊 Analytics"** tab to access:
    - **Ask your Job Database**: Use RAG to query your specific job list (e.g., "Find me jobs dealing with Fintech").
    - **Global Skill Gap**: Get a strategic analysis of missing skills across *all* your top job matches.
