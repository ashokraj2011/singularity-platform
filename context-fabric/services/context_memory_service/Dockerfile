FROM python:3.11-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1
ENV PYTHONPATH=/app:/app/shared
COPY services/context_memory_service/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt
COPY shared /app/shared
COPY services/context_memory_service /app/services/context_memory_service
EXPOSE 8002
CMD ["uvicorn", "services.context_memory_service.app.main:app", "--host", "0.0.0.0", "--port", "8002"]
