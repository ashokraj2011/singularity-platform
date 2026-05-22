# M62 Slice A — Prompt Compressor Service (LLMLingua-2 sidecar).
#
# Design intent: zero runtime network. The llmlingua-2 BERT base model
# (~180MB) is downloaded ONCE at image build time via a small bake script.
# The running container never reaches huggingface.co — important for
# office / air-gapped networks that block outbound traffic.
#
# If you change COMPRESSION_MODEL_NAME at runtime to a model NOT baked in
# below, the first compress call will attempt a hub download and fail
# without outbound network. To switch models, rebuild the image with the
# COMPRESSION_BAKE_MODEL build-arg pointed at the new name.

FROM python:3.11-slim

WORKDIR /app
ENV PYTHONUNBUFFERED=1
ENV PYTHONPATH=/app:/app/shared

# Install torch CPU wheel separately — the GPU wheel is ~700MB heavier
# and we run on CPU. Pin to the official PyTorch CPU index.
RUN pip install --no-cache-dir torch==2.5.1 --index-url https://download.pytorch.org/whl/cpu

COPY services/prompt_compressor_service/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

# Bake the model into the image. The HF_HOME env locks the cache to a
# known path that the runtime container reads. transformers + tokenizers
# pull both the model weights and the tokenizer JSON.
#
# Override at build time:
#   docker compose build --build-arg COMPRESSION_BAKE_MODEL=other/model prompt-compressor
ARG COMPRESSION_BAKE_MODEL=microsoft/llmlingua-2-bert-base-multilingual-cased-meetingbank
ENV HF_HOME=/opt/hf-cache
ENV TRANSFORMERS_OFFLINE=0
RUN python -c "\
from transformers import AutoTokenizer, AutoModelForTokenClassification; \
name = '${COMPRESSION_BAKE_MODEL}'; \
print(f'[bake] downloading tokenizer for {name}'); \
AutoTokenizer.from_pretrained(name); \
print(f'[bake] downloading model for {name}'); \
AutoModelForTokenClassification.from_pretrained(name); \
print('[bake] done')"

# Now flip the runtime container to OFFLINE so a stale env or a code
# bug can't accidentally trigger an outbound fetch.
ENV TRANSFORMERS_OFFLINE=1
ENV HF_HUB_OFFLINE=1

COPY services/prompt_compressor_service /app/services/prompt_compressor_service

EXPOSE 8011
CMD ["uvicorn", "services.prompt_compressor_service.app.main:app", "--host", "0.0.0.0", "--port", "8011"]
