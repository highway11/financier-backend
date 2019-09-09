FROM nginx:1.17-alpine

COPY ./nginx.conf /etc/nginx/conf.d/default.conf

COPY ./dist /var/www/static

RUN chown nginx:nginx /var/www/static


EXPOSE 8080
