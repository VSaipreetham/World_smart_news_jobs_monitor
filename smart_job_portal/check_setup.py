
import os
import sys
from dotenv import load_dotenv

load_dotenv()

print("--- System Check ---")
print(f"Python version: {sys.version}")

try:
    import psycopg2
    print("✅ psycopg2 is installed")
except ImportError:
    print("❌ psycopg2 is NOT installed. Run: pip install psycopg2-binary")

db_url = os.getenv("DATABASE_URL")
if db_url:
    print(f"✅ DATABASE_URL found: {db_url[:20]}...")
    try:
        from sqlalchemy import create_engine
        engine = create_engine(db_url)
        with engine.connect() as conn:
            print("✅ Database connection successful!")
    except Exception as e:
        print(f"❌ Database connection failed: {e}")
else:
    print("ℹ️ No DATABASE_URL found. Using local SQLite.")

try:
    from models import Job
    print("✅ SQLAlchemy models loaded correctly.")
except Exception as e:
    print(f"❌ Failed to load models: {e}")
