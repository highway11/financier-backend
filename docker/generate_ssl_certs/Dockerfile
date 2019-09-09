# This container generates SSL self-signed certs in case you don't have your
# own.  These are necessary for using https.
from alpine

RUN apk add --no-cache openssl


COPY . /scripts
WORKDIR /scripts
RUN chmod +x create_certs.sh
ENTRYPOINT []
