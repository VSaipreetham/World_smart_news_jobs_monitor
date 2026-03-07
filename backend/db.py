import os
import datetime
from sqlalchemy import create_engine, Column, Integer, String, Float, DateTime
from sqlalchemy.orm import sessionmaker, declarative_base

db_url = os.getenv("DATABASE_URL")
if db_url and db_url.startswith("postgres://"):
    db_url = db_url.replace("postgres://", "postgresql://", 1)

# Connect to user's specified Postgres string, else use SQLite locally.
if db_url:
    engine = create_engine(db_url)
    print("Postgres Live Database Attached.")
else:
    engine = create_engine("sqlite:///worldmonitor.db", connect_args={'check_same_thread': False})
    print("Local SQLite Database Attached.")

Base = declarative_base()

class DataNode(Base):
    __tablename__ = 'world_nodes'
    id = Column(Integer, primary_key=True)
    node_type = Column(String)  # 'job' or 'news'
    title = Column(String)      # headline or job role
    company_or_source = Column(String) # Tech company or RSS source
    location_name = Column(String, nullable=True) # city
    lat = Column(Float)
    lng = Column(Float)
    url = Column(String, unique=True)
    timestamp = Column(DateTime, default=datetime.datetime.utcnow)

# Instantiate Database Structure
Base.metadata.create_all(engine)
SessionLocal = sessionmaker(bind=engine)
