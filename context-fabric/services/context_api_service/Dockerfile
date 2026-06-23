FROM python:3.11-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1
ENV PYTHONPATH=/app:/app/shared
# M67 Slice 1C — context-memory's deps merged into context-api's
# requirements.txt so both route surfaces can co-host in this one image.
COPY services/context_api_service/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt
COPY shared /app/shared
COPY services/context_api_service /app/services/context_api_service
# M67 Slice 1C — Bring context-memory's app code (routes.py + repository,
# summarizer, memory_search, context_compiler, context_sanitizer) into the
# image so context-api can import services.context_memory_service.app.routes.
# Required because the routes touch the local SQLite DB via repository.py.
COPY services/context_memory_service /app/services/context_memory_service
RUN mkdir -p /app/data && chmod 0777 /app/data
EXPOSE 8000
CMD ["uvicorn", "services.context_api_service.app.main:app", "--host", "0.0.0.0", "--port", "8000"]
