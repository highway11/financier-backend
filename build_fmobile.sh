# This script builds the fmobile application and moves the resulting
# dist files to the nginx container.
docker build -t fmobile ./docker/financier_mobile
docker run --rm -it -v `pwd`/docker/financier_mobile/fmobile:/fmobile fmobile
mv ./docker/financier_mobile/fmobile/dist ./docker/nginx
