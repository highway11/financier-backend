FROM python:3.7-alpine3.10

COPY requirements.txt /
RUN pip install -r /requirements.txt

COPY . /app

WORKDIR /app

EXPOSE 5000

ENV FLASK_APP=db_api.py
ENV FLASK_ENV=development
CMD ["gunicorn", "-b", "0.0.0.0:5000", "db_api"] #, "--log-level", "debug"]
