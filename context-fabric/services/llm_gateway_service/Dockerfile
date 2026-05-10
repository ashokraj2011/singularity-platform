FROM python:3.11-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1
ENV PYTHONPATH=/app:/app/shared
COPY services/llm_gateway_service/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt
COPY shared /app/shared
COPY services/llm_gateway_service /app/services/llm_gateway_service
EXPOSE 8001
CMD ["uvicorn", "services.llm_gateway_service.app.main:app", "--host", "0.0.0.0", "--port", "8001"]
