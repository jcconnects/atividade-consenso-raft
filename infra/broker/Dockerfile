FROM python:3.12-alpine
RUN apk add --no-cache docker-cli
COPY broker.py /app/broker.py
WORKDIR /app
EXPOSE 9100
CMD ["python", "broker.py"]
