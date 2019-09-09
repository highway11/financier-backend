# Follow the steps here:
# https://docs.docker.com/engine/swarm/secrets/#intermediate-example-use-secrets-with-a-nginx-service

# Generate a root key.
openssl genrsa -out "root-ca.key" 4096
# Generate a CSR using the root key.
openssl req \
          -new -key "root-ca.key" \
          -out "root-ca.csr" -sha256 \
          -subj '/C=US/ST=CA/L=San Francisco/O=Docker/CN=Swarm Secret Example CA'
# Configure the root CA.
echo -e "[root_ca]
  basicConstraints = critical,CA:TRUE,pathlen:1
  keyUsage = critical, nonRepudiation, cRLSign, keyCertSign
  subjectKeyIdentifier=hash" > root-ca.cnf
# Sign the certificate.
openssl x509 -req  -days 3650  -in "root-ca.csr" \
               -signkey "root-ca.key" -sha256 -out "root-ca.crt" \
               -extfile "root-ca.cnf" -extensions \
               root_ca
# Generate the site key.
openssl genrsa -out "site.key" 4096
# Generate the site certificate and sign it with the site key.
openssl req -new -key "site.key" -out "site.csr" -sha256 \
          -subj '/C=US/ST=CA/L=San Francisco/O=Docker/CN=localhost'
# Configure the site certificate.
echo -e "[server]
  authorityKeyIdentifier=keyid,issuer
  basicConstraints = critical,CA:FALSE
  extendedKeyUsage=serverAuth
  keyUsage = critical, digitalSignature, keyEncipherment
  subjectAltName = DNS:localhost, IP:127.0.0.1
  subjectKeyIdentifier=hash" > site.cnf
# Sign the site certificate.
openssl x509 -req -days 750 -in "site.csr" -sha256 \
    -CA "root-ca.crt" -CAkey "root-ca.key"  -CAcreateserial \
    -out "site.crt" -extfile "site.cnf" -extensions server
mkdir /secrets
cp ./site.crt /secrets/site.crt
cp ./site.key /secrets/site.key
