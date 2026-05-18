FROM python:3.11-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1
ENV PYTHONPATH=/app:/app/shared
COPY services/formal_verifier_service/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt
COPY services/formal_verifier_service /app/services/formal_verifier_service
EXPOSE 8010
CMD ["uvicorn", "services.formal_verifier_service.app.main:app", "--host", "0.0.0.0", "--port", "8010"]
