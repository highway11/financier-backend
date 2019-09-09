from alpine

RUN apk add --no-cache curl

# In order to use this container for initializing the couchdb database, we have
# to wait for it to become available.  We'll use wait-for for this.
# see https://github.com/Eficode/wait-for

COPY . /
WORKDIR /
RUN chmod +x /wait-for \
  && chmod +x /couchdb_init.sh
