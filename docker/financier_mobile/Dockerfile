FROM node:8-alpine

RUN apk add --update \
  python \
  alpine-sdk

#COPY ./fmobile /fmobile
WORKDIR /tmp
RUN git clone https://gitlab.com/asromzek/fmobile.git
WORKDIR /tmp/fmobile

RUN npm install
RUN npm run build

CMD ["cp", "-r", "dist", "/fmobile/dist"]

# Run using docker build -t fmobile .
#
