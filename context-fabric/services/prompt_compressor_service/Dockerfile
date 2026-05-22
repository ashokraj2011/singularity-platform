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

# M62 Slice F — Strategy-aware build. The default strategy is
# stopword removal which needs zero ML deps. Setting
# COMPRESSION_BAKE_MODEL=skip in the build args produces a tiny
# image (~200MB instead of ~3GB) suitable for production deployments
# that use the stopwords strategy exclusively. Switch to a real
# model id to bake LLMLingua-2 weights for the opt-in strategy.
ARG COMPRESSION_BAKE_MODEL=skip

# Always install the FastAPI + pydantic core. llmlingua + torch +
# transformers are only added when COMPRESSION_BAKE_MODEL != "skip".
COPY services/prompt_compressor_service/requirements.txt /app/requirements.txt
RUN if [ "${COMPRESSION_BAKE_MODEL}" = "skip" ]; then \
        echo "[build] stopwords-only build — skipping torch/llmlingua install"; \
        # Install only the lean runtime: FastAPI + pydantic + tests deps.
        pip install --no-cache-dir \
            fastapi==0.115.6 \
            'uvicorn[standard]==0.34.0' \
            pydantic==2.10.4 \
            pydantic-settings==2.7.1 \
            pytest==8.3.4 \
            httpx==0.28.1; \
    else \
        echo "[build] llmlingua build — installing torch CPU + transformers + llmlingua"; \
        pip install --no-cache-dir torch==2.5.1 --index-url https://download.pytorch.org/whl/cpu && \
        pip install --no-cache-dir -r /app/requirements.txt; \
    fi

# Bake the model only when a real model id was supplied. The skip
# branch produces a tiny image and the runtime container will use
# the stopwords strategy.
ENV HF_HOME=/opt/hf-cache
ENV TRANSFORMERS_OFFLINE=0
RUN if [ "${COMPRESSION_BAKE_MODEL}" != "skip" ]; then \
        python -c "\
from transformers import AutoTokenizer, AutoModelForTokenClassification; \
name = '${COMPRESSION_BAKE_MODEL}'; \
print(f'[bake] downloading tokenizer for {name}'); \
AutoTokenizer.from_pretrained(name); \
print(f'[bake] downloading model for {name}'); \
AutoModelForTokenClassification.from_pretrained(name); \
print('[bake] done')"; \
    fi

# Lock runtime to OFFLINE regardless — if llmlingua was baked, the cache
# is sufficient; if it wasn't, transformers isn't imported so the env
# vars are inert.
ENV TRANSFORMERS_OFFLINE=1
ENV HF_HUB_OFFLINE=1

COPY services/prompt_compressor_service /app/services/prompt_compressor_service

EXPOSE 8011
CMD ["uvicorn", "services.prompt_compressor_service.app.main:app", "--host", "0.0.0.0", "--port", "8011"]
