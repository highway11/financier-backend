ADMIN_PASSWORD=$(cat /run/secrets/admin_password)
HOST="http://couchdb:5984"
# To create the admin user, the config endpoint has a different port
CONFIG_HOST="http://couchdb:5986"

script='curl -X PUT ${1}/${2}'
echo $script
echo "sh -c \"$script\" -- \"_users\""
echo "Creating couchdb system databases _users, _global_changes and _replicator"
sh -c "$script" -- "$HOST" "_users"
sh -c "$script" -- "$HOST" "_replicator"
sh -c "$script" -- "$HOST" "_global_changes"


if [ -n "$ADMIN_PASSWORD" ]
then
  echo "Setting couchdb admin password"
  sh -c "curl -X PUT $CONFIG_HOST/_config/admins/admin -d '\"$ADMIN_PASSWORD\"'"
fi
