# Quick Start
Download or clone the repository.  Open a terminal/cmd line in the cloned directory and run

[//]: # (Docker swarm may be necessary here)
```
docker-compose pull
docker-compose run --rm generate_ssl_certs sh ./create_certs.sh
docker-compose up -d --no-build
```
Then navigate to `localhost` in your favorite browser to start using Financier.
The Financier mobile app is available at `localhost/mobile`.

Run
```
docker-compose down
```
to shut Financier down.

When you're restarting Financier again in the future you only need to run
`docker-compose up -d --no-build`, there's no need to pull the images or create
the certs again.

# Detailed Instructions
The above steps will get Financier up and running locally in a Dockerized
application, with a persistent local CouchDB to store your budget data.  This
is a detailed explanation of each step.

0. Make sure you have Docker installed on your [Mac](https://docs.docker.com/docker-for-mac/install/), or
[Windows](https://docs.docker.com/docker-for-windows/install/) machine.  This should include `docker-compose`.
1. Download the file `docker-compose.yml` from this repo (or you can just clone
  or download the whole repo).  Save the file to a directory where you want
  your budgets to be stored (the budgets will be stored in the subdirectory `couchdb_data` that will be automatically created for you later).
3. `cd` into the directory where `docker-compose.yml` is stored and run
`docker-compose pull` to pull the prebuilt Financier images.  You only ever need
to pull the images once, you won't repeat this step in the future.
5. *You only ever need to run this step once to generate keys, if you're just restarting
Financier it's not necessary.*  
If you don't have your own SSL certificate (if you don't know what this means you
don't have one), run `docker-compose run --rm generate_ssl_certs sh ./create_certs.sh`.
This will generate a self-signed SSL certificate and key in the subdirectory `secrets`
that will be used to enable https on your local Financier.  
If you have your own keys/cert, just make the subdirectory `secrets` yourself and
move your key and cert file there.  Make sure they're named `site.key` and `site.crt`.
6. Run `docker-compose up -d --no-build`. This will start the Financier server in
the background.
7. Navigate your favorite modern browser to `localhost`.  You can now use Financier
like you normally would.  Create users, perform your budgeting tasks, etc.  Billing
flows won't work but it won't matter for a local install that you and your family will use.  
Note that we're using self-signed certificates, so your browser will
probably complain that the host is unknown/insecure.  Most browsers have a way
to allow `localhost` to have a self-signed certificate.  In Chrome, for example,
paste `chrome://flags/#allow-insecure-localhost`
into the address bar and then click 'enable' on 'allow invalid certificates for resources loaded from localhost.'  Or see [this](https://stackoverflow.com/questions/7580508/getting-chrome-to-accept-self-signed-localhost-certificate) Stack Overflow thread.  See [here](https://improveandrepeat.com/2016/09/allowing-self-signed-certificates-on-localhost-with-chrome-and-firefox/) for Firefox.
8. When you want to shut down your Financier server, simply run `docker-compose down`
and the app will be shutdown and all the containers deleted.  Your budget data
will remain and be available the next time you start Financier as long as you
don't delete `couchdb_data`.

# Database Password
By default, the above instructions run CoucbDB in [admin party mode](https://docs.couchdb.org/en/stable/intro/security.html).  
To avoid this, you can place a file called `admin_password.txt` in the `secrets`
subdirectory that was created above.  After you create that file, running Financier
as above will automatically set the CouchDB admin password to the value in that
file and use it for future username creation.


# Advanced Users
You can also deploy Financier on a `docker swarm` by using `docker stack deploy`
instead of `docker-compose up`.  
For some reason, leaving my wifi on while deploying with docker stack messes up
nginx's upstreams.  I still have no idea why this happens, but I think it might
be related to the overlay networking that comes with `docker stack deploy` by default.
Deploying with `docker-compose` doesn't have
this issue.  Either way, the workaround for me has been to turn off wifi, deploy,
and then turn wifi back on.  The symptom of this issue will be 502 errors in the app, and then
when you check the `nginx` logs you'll see a bunch of issues with upstreams.

# Building from Scratch
In order to build the entire project from scratch:

1. Build the Financier mobile application from source by running
`./build_fmobile.sh`.
2. Build the rest of the docker images using `docker-compose build` (assuming
  you've got your certs built already; otherwise see above).
