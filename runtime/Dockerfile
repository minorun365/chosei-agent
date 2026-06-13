FROM public.ecr.aws/docker/library/python:3.13-slim

WORKDIR /app
ENV PYTHONUNBUFFERED=1

COPY requirements.txt .

# AgentCore BrowserのCDP接続に必要なPython依存を入れる
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8080
CMD ["python", "main.py"]
