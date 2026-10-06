FROM python:3.12-slim

WORKDIR /app

COPY app/requirements.txt requirements.txt

RUN pip install --no-cache-dir -r requirements.txt

# mem0ai comes from our fork, not PyPI: the System One gates are ours
# (PI-FORK.md in DenisSud/mem0). fetch-fork.sh places the checkout in
# mem0-src/ before the build; it is gitignored and not baked in.
COPY mem0-src/ /src/mem0-src/
RUN pip install --no-cache-dir /src/mem0-src && rm -rf /src

COPY app/ .

EXPOSE 8000

ENV PYTHONUNBUFFERED=1

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]
