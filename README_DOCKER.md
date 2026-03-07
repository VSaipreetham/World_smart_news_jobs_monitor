### 🐳 Docker Deployment

The application is fully containerized and ready for production deployment using Docker Compose.

1. Ensure [Docker Desktop](https://www.docker.com/products/docker-desktop/) is installed and running.
2. Ensure you have created your `.env` files in `backend_node` and `smart_job_portal` with your keys.
3. Open a terminal in the root directory.
4. Run the following command to build and start all 3 services:
   ```bash
   docker-compose up -d --build
   ```
5. Access your apps:
   - **Frontend UI & Visualization**: http://localhost
   - **Backend API Server**: http://localhost:8000
   - **Smart Job Portal API**: http://localhost:8501
   
To stop the application cleanly, run:
```bash
docker-compose down
```
