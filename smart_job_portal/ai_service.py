
import streamlit as st
import os
import google.generativeai as genai
import pdfplumber

# Placeholder for lazy-loaded modules
SentenceTransformer = None
util = None
pipeline = None
torch = None

# Model Constants
EMBEDDING_MODEL_NAME = 'sentence-transformers/all-MiniLM-L6-v2' 
LLM_MODEL_NAME = 'MBZUAI/LaMini-Flan-T5-248M' 

class AICoach:
    def __init__(self):
        self.embedding_model = None
        self.llm_pipeline = None
        self.gemini_key = os.getenv("Google_token")
        self.trinity_key = os.getenv("trinity-large-preview_token")
        self.qwen_key = os.getenv("Qwen3_80b_token") 
        self.gemma_key = os.getenv("Gemma3b_token")
        self.gpt_oss_key = os.getenv("gpt-oss-120b_token")
        self.claude_key = os.getenv("CLAUDE_API_KEY") # User checks if they have this
        self.device = "cpu" # Default until torch loads

    def set_gemini_key(self, key):
        self.gemini_key = key

    def _ensure_imports(self):
        """Lazy load heavy libraries."""
        global SentenceTransformer, util, pipeline, torch
        
        if torch is None:
            with st.spinner("Initializing AI Core (One-time setup)..."):
                import torch
                self.device = "cuda" if torch.cuda.is_available() else "cpu"
                
        if SentenceTransformer is None:
            from sentence_transformers import SentenceTransformer, util
            
        if pipeline is None:
            from transformers import pipeline

    def load_embedding_model(self):
        """Loads embedding model (lightweight) separately."""
        self._ensure_imports()
        if self.embedding_model is None:
            try:
                self.embedding_model = SentenceTransformer(EMBEDDING_MODEL_NAME, device=self.device)
            except Exception as e:
                st.error(f"Error loading Embeddings: {e}")

    def load_local_llm(self):
        """Loads local LLM only if needed."""
        self._ensure_imports()
        if self.llm_pipeline is None:
            try:
                st.toast("Downloading/Loading Local LLM... this may take a moment.")
                self.llm_pipeline = pipeline(
                    "text2text-generation", 
                    model=LLM_MODEL_NAME, 
                    device=0 if self.device == "cuda" else -1,
                    max_length=512
                )
            except Exception as e:
                st.error(f"Error loading Local LLM: {e}")

    def embed_text(self, text):
        self.load_embedding_model() # Ensure loaded
        if self.embedding_model:
            return self.embedding_model.encode(text, convert_to_tensor=True)
        return None

    def calculate_match(self, resume_text, job_description):
        self.load_embedding_model()
        if not self.embedding_model or not resume_text or not job_description:
            return 0
        resume_emb = self.embedding_model.encode(resume_text, convert_to_tensor=True)
        job_emb = self.embedding_model.encode(job_description, convert_to_tensor=True)
        score = util.cos_sim(resume_emb, job_emb).item()
        return round(score * 100, 1)

    def batch_rank_jobs(self, resume_text, jobs_list):
        """
        RAG Retrieval Step: Ranks a list of jobs against the resume.
        jobs_list: list of dicts or objects with 'title', 'company', 'location', 'source'
        """
        self.load_embedding_model()
        if not self.embedding_model:
            return []
            
        resume_emb = self.embedding_model.encode(resume_text, convert_to_tensor=True)
        scored_jobs = []
        
        # Create text representations for embedding
        # Handle both Dicts (from DataFrame) and Objects (from SQLAlchemy)
        def get_text(j):
            if isinstance(j, dict):
                return f"{j.get('title','')} {j.get('company','')} {j.get('location','')} {j.get('source','')}"
            return f"{j.title} {j.company} {j.location} {j.source}"
            
        job_texts = [get_text(j) for j in jobs_list]
        job_embs = self.embedding_model.encode(job_texts, convert_to_tensor=True)
        
        # Calculate Cosine Similarity
        cosine_scores = util.cos_sim(resume_emb, job_embs)[0]
        
        # Pair up and sort
        for i, score in enumerate(cosine_scores):
            scored_jobs.append((jobs_list[i], score.item()))
            
        # Sort desc
        scored_jobs.sort(key=lambda x: x[1], reverse=True)
        return scored_jobs

    def get_available_models(self):
        """Returns a list of models available for selection."""
        models = []
        
        # Gemini Models
        if self.gemini_key:
             # We can list the top priorities
             models.append({"id": "models/gemini-2.5-flash", "name": "Gemini 2.5 Flash (Fast)", "provider": "gemini"})
             models.append({"id": "models/gemini-2.0-flash", "name": "Gemini 2.0 Flash (Stable)", "provider": "gemini"})
             models.append({"id": "models/gemini-1.5-flash", "name": "Gemini 1.5 Flash", "provider": "gemini"})
             models.append({"id": "models/gemini-1.5-pro", "name": "Gemini 1.5 Pro (Brainy)", "provider": "gemini"})
        
        # OpenRouter Models
        if self.trinity_key:
            models.append({"id": "arcee-ai/trinity-large-preview:free", "name": "Trinity (OpenRouter)", "provider": "openrouter", "key": self.trinity_key})
        
        if self.qwen_key:
            models.append({"id": "qwen/qwen3-next-80b-a3b-instruct:free", "name": "Qwen 3 80B (OpenRouter)", "provider": "openrouter", "key": self.qwen_key})
            
        if self.gemma_key:
            models.append({"id": "google/gemma-3-27b-it:free", "name": "Gemma 3 27B (OpenRouter)", "provider": "openrouter", "key": self.gemma_key})
            
        if self.gpt_oss_key:
             # Assuming this maps to a specific model, or we use a generic free one if the key is valid
             # "gpt-oss-120b" implies maybe "alpindale/goliath-120b" or similar? or just a custom name.
             # Let's try a standard free "GPT-like" model on OpenRouter: Llama 3 or Mistral
             models.append({"id": "meta-llama/llama-3-8b-instruct:free", "name": "Llama 3 8B (Free)", "provider": "openrouter", "key": self.gpt_oss_key})
             models.append({"id": "microsoft/phi-3-mini-128k-instruct:free", "name": "Phi-3 Mini (Free)", "provider": "openrouter", "key": self.gpt_oss_key})
        
        if self.claude_key:
             # Direct Anthropic
             models.append({"id": "claude-3-opus-20240229", "name": "Claude 3 Opus", "provider": "anthropic"})
             models.append({"id": "claude-3-sonnet-20240229", "name": "Claude 3 Sonnet", "provider": "anthropic"})
             models.append({"id": "claude-3-haiku-20240307", "name": "Claude 3 Haiku", "provider": "anthropic"})
            
        # Local
        models.append({"id": "local", "name": "Local LLM (LaMini)", "provider": "local"})
        
        return models

    def _call_openrouter(self, prompt, api_key, model_name):
        """Calls OpenRouter API for alternative models."""
        if not api_key:
            return None
        
        import requests
        import json
        
        # OpenRouter standard headers
        url = "https://openrouter.ai/api/v1/chat/completions"
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "HTTP-Referer": "http://localhost:8501", # Localhost for testing
            "X-Title": "Smart Job Portal",
        }
        data = {
            "model": model_name,
            "messages": [{"role": "user", "content": prompt}]
        }
        
        try:
            response = requests.post(url, headers=headers, data=json.dumps(data), timeout=20)
            if response.status_code == 200:
                result = response.json()
                return result['choices'][0]['message']['content']
            elif response.status_code == 401:
                print(f"OpenRouter Auth Error ({model_name}): Check your API Key.")
                st.toast(f"⚠️ Auth Error for {model_name}. Check .env key.")
                return None
            else:
                print(f"OpenRouter Error ({model_name}): {response.status_code} {response.text}")
                return None
        except Exception as e:
            print(f"Request Error ({model_name}): {e}")
            return None

    def generate_response(self, prompt, model_conf, label_override=None):
        """Generates response using specific model config."""
        if not model_conf:
            return "Error: No Model Selected"
            
        provider = model_conf.get('provider')
        model_id = model_conf.get('id')
        label = label_override if label_override else f"AI Analysis ({model_conf.get('name')})"
        
        if provider == 'gemini':
            genai.configure(api_key=self.gemini_key)
            model = genai.GenerativeModel(model_id)
            response = model.generate_content(prompt)
            if response and hasattr(response, 'text'):
                return f"**{label}:**\n\n{response.text}"
            else:
                raise Exception("Gemini returned empty response")
            
        elif provider == 'openrouter':
            key = model_conf.get('key')
            res = self._call_openrouter(prompt, key, model_id)
            if res:
                return f"**{label}:**\n\n{res}"
            else:
                 raise Exception(f"OpenRouter ({model_id}) Failed")
        
        elif provider == 'anthropic':
             # Requires: pip install anthropic
             try:
                 import anthropic
                 client = anthropic.Anthropic(api_key=self.claude_key)
                 message = client.messages.create(
                    model=model_id,
                    max_tokens=1000,
                    messages=[{"role": "user", "content": prompt}]
                )
                 return f"**{label}:**\n\n{message.content[0].text}"
             except ImportError:
                 return "Error: `anthropic` library not installed."
             except Exception as e:
                 raise Exception(f"Claude Error: {e}")
            
        elif provider == 'local':
            self.load_local_llm()
            if self.llm_pipeline:
                output = self.llm_pipeline(prompt, max_length=512, do_sample=True, temperature=0.7)
                return f"**{label}:**\n\n{output[0]['generated_text']}"
            else:
                raise Exception("Local LLM failed to load")
            
        return "Invalid Model Selected"

    def get_advice(self, resume_text, job_description):
        """Centralized advice with fallback chain."""
        prompt = f"""
        You are an expert AI Career Companion. Help the user land this job.
        
        **Target Job Description:**
        {job_description[:4000]}
        
        **User's Resume:**
        {resume_text[:4000]}
        
        **Task:**
        1. Identify the top 3 critical skills missing from the resume.
        2. Provide 1 specific, actionable piece of advice to improve their chances.
        3. Rate their fit for this role on a scale of 1-10.
        
        **Tone:** Encouraging but realistic.
        Response:
        """
    def get_advice(self, resume_text, job_description, model_conf=None):
        """Centralized advice with fallback chain."""
        prompt = f"""
        You are an expert AI Career Companion. Help the user land this job.
        
        **Target Job Description:**
        {job_description[:4000]}
        
        **User's Resume:**
        {resume_text[:4000]}
        
        **Task:**
        1. Identify the top 3 critical skills missing from the resume.
        2. Provide 1 specific, actionable piece of advice to improve their chances.
        3. Rate their fit for this role on a scale of 1-10.
        
        **Tone:** Encouraging but realistic.
        Response:
        """
        return self.generate_response(prompt, model_conf)

    def ask_coach(self, user_question, context=""):
        prompt = f"""
        You are a helpful AI Career Companion.
        
        **Context (Resume/Job Info):**
        {context[:5000]}
        
        **User Question:**
        {user_question}
        
        **Answer:**
        """
    def ask_coach(self, user_question, context="", model_conf=None):
        prompt = f"""
        You are a helpful AI Career Companion.
        
        **Context (Resume/Job Info):**
        {context[:5000]}
        
        **User Question:**
        {user_question}
        
        **Answer:**
        """
        return self.generate_response(prompt, model_conf)

    def estimate_market_ranges(self, jobs_data, model_conf=None):
        """
        RAG-based Estimation:
        jobs_data: A list of dicts representing the raw job data from the user's database.
        We provide this 'Context' to the LLM so it estimates based on the ACTUAL companies/roles found, 
        not just generic titles.
        """
        
        # 1. RETRIEVAL STEP (Summarizing context window)
        # We take a sample of recent jobs to form the "Market Context" from the DB
        context_lines = []
        for j in jobs_data[:50]: # Feed up to 50 jobs for context
            pay_info = f" | Mentioned Pay: {j.get('pay')}" if j.get('pay') and len(str(j.get('pay'))) > 3 else ""
            line = f"- {j.get('title')} @ {j.get('company')} ({j.get('location')}){pay_info}"
            context_lines.append(line)
        
        context_str = "\n".join(context_lines)
        
        # 2. AUGMENTED PROMPT
        prompt = f"""
        You are a Specialized Data Analyst for a Job Board.
        
        **Goal:** Estimate salary ranges for the top roles found in this specific dataset.
        
        **The User's Job Database (Recent Listings):**
        {context_str}
        
        **Task:**
        1. Analyze the specific companies and demand signals in the list above.
        2. Group similar roles (e.g. "Python Devs", "Product Managers").
        3. using your internal market knowledge AND the specific companies listed (e.g. Block vs Startup), provide a refined salary estimate (USD).
        
        **Output Format:**
        Markdown table: | Role Group | Companies Found | Estimated Range (USD) | Insight |
        """
        
        return self.generate_response(prompt, model_conf, label_override="AI Salary Analysis")

    def market_insights_rag(self, user_query, jobs_data, model_conf=None):
        """
        RAG-based Market Intelligence: Answer questions using the job DB as context.
        jobs_data: List of dicts (title, company, location, etc.)
        """
        self.load_embedding_model()
        if not self.embedding_model or not jobs_data:
            return "AI or Data not available."

        # 1. Prepare Data
        # Limit to recent 200 for performance if list is huge
        proc_jobs = jobs_data[:200]
        job_texts = [f"{j.get('title')} @ {j.get('company')} ({j.get('location')}) - {j.get('pay','')} [Source: {j.get('source')}]" for j in proc_jobs]
        
        # 2. Embed
        query_emb = self.embedding_model.encode(user_query, convert_to_tensor=True)
        job_embs = self.embedding_model.encode(job_texts, convert_to_tensor=True)
        
        # 3. Retrieve Top Context (Top 15)
        # Check if we have enough jobs
        k = min(15, len(job_texts))
        scores = util.cos_sim(query_emb, job_embs)[0]
        top_results = torch.topk(scores, k=k)
        
        context_items = [job_texts[idx] for idx in top_results.indices]
        context_str = "\n".join(context_items)
        
        # 4. Generate Insight
        prompt = f"""
        You are a Senior Job Market Analyst.
        
        **User Query:** '{user_query}'
        
        **Relevant Market Data (from database):**
        {context_str}
        
        **Instructions:**
        1. Answer the query using ONLY the provided data.
        2. Cite specific companies or roles if relevant.
        3. Identify trends if asked.
        4. If the data doesn't support an answer, say so.
        """
        
        return self.generate_response(prompt, model_conf, label_override="Market AI Insight")

    def global_skills_gap(self, resume_text, jobs_data, model_conf=None):
        """
        Analyze the resume against the aggregate of the jobs list to find SYSTEMATIC gaps.
        """
        # We don't need RAG here as much as just a high-level summary of the JOB descriptions.
        # But we can't fit 200 jobs in context.
        # Strategy: Sample 20 representative jobs or Top 20 best matches.
        
        # Let's use the Ranking method first to find the 20 *most relevant* jobs to this user
        # so we don't suggest skills for irrelevant jobs.
        
        ranked_jobs = self.batch_rank_jobs(resume_text, jobs_data)
        if not ranked_jobs:
            return "No jobs to analyze."
            
        # Take top 20 relevant jobs
        top_20 = [x[0] for x in ranked_jobs[:20]]
        
        # Create a condensed context
        job_summaries = []
        for j in top_20:
             # If we have proper descriptions in the future, use them. 
             # For now, use Title + Company + Notes/Source as proxy for requirements
             # Treat 'j' as object if it has .title, else dict
             if hasattr(j, 'title'):
                  job_summaries.append(f"- {j.title} @ {j.company}: {j.source}")
             else:
                  job_summaries.append(f"- {j.get('title')} @ {j.get('company')}: {j.get('source')}")
             
        context_str = "\n".join(job_summaries)
        
        prompt = f"""
        You are a Career Strategist.
        
        **User Resume Summary:**
        {resume_text[:2000]}
        
        **Top 20 Target Jobs (Most aligned to user):**
        {context_str}
        
        **Task:**
        1. Identify the **Common Skill Gaps** across these specific roles that the user is missing.
        2. Don't nitpick. Look for MAJOR missing keywords (e.g. "Cloud", "Python", "Management").
        3. Suggest a strategic "Learning Path" to bridge this gap.
        
        **Output:**
        ## 🚨 Strategic Skill Gaps
        ...
        ## 🚀 Recommended Learning Path
        ...
        """
        
        return self.generate_response(prompt, model_conf, label_override="Strategic Gap Analysis")

    def generate_cover_letter(self, resume_text, job_details, model_conf=None):
        """Generates a tailored cover letter."""
        prompt = f"""
        You are an expert Resume Writer. Write a professional, compelling cover letter.
        
        **My Resume Summary:**
        {resume_text[:2000]}
        
        **Target Job:**
        {job_details}
        
        **Goal:** convince the hiring manager I am the perfect fit. Keep it concise (under 300 words).
        Use a standard professional format.
        """
        # Fix: Pass model_conf explicitly
        return self.ask_coach(prompt, context="", model_conf=model_conf)

    def generate_interview_questions(self, job_details, model_conf=None):
        """Generates tailored interview prep based on company style."""
        prompt = f"""
        You are an expert Technical Interview Coach. 
        
        **Target Job:** {job_details}
        
        **Task:**
        1. Analyze the **Company Culture/Style**: Is it Big Tech (FAANG), a scraped Startup, a Bank/Enterprise, or an Agency?
        2. Generate 3 **Style-Specific** Interview Questions asking about:
           - **Question 1: Behavioral/Culture Fit** (tailored to their implied values).
           - **Question 2: Hard Technical Skill which includes DSA and LLD and HLD etc depends on the job role and standard of company** (crucial for this role).
           - **Question 3: Scenario/System Design** (relevant to their product/domain).
        
        3. For EACH question, provide a **"Winning Answer Strategy"** (bullet points on what to say).
        
        **Output Format:**
        ### 🏢 Company Style: [Your Analysis]
        
        #### Q1: [Question]
        *   **💡 Answer Strategy:** [Tips]
        
        ... (repeat for Q2, Q3)
        """
        return self.ask_coach(prompt, context="", model_conf=model_conf)

    def generate_cold_message(self, job_details, model_conf=None):
        """Generates a LinkedIn connection note."""
        prompt = f"""
        Write a 300-character LinkedIn connection request message to a recruiter at this company.
        
        **Job:** {job_details}
        
        The message should be polite, professional, and mention my interest in this specific role.
        """
        return self.ask_coach(prompt, context="", model_conf=model_conf)

def extract_text_from_pdf(uploaded_file):
    try:
        with pdfplumber.open(uploaded_file) as pdf:
            text = ""
            for page in pdf.pages:
                text += page.extract_text() + "\n"
        return text
    except Exception as e:
        return f"Error reading PDF: {e}"

# Singleton instance
@st.cache_resource
def get_ai_coach():
    coach = AICoach()
    # We do NOT pre-load embeddings anymore to save startup time.
    # They will be loaded on first use.
    return coach
