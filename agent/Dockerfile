FROM public.ecr.aws/docker/library/python:3.13-slim

WORKDIR /app
ENV PYTHONUNBUFFERED=1
RUN useradd -m -u 1000 bedrock_agentcore

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY --chown=bedrock_agentcore:bedrock_agentcore . .
EXPOSE 8080
USER bedrock_agentcore
CMD ["opentelemetry-instrument", "python", "main.py"]
