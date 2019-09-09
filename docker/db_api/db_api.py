from flask import Flask, request
from requests import post, put
import json
from pathlib import Path

application = Flask(__name__)
p = Path("/run/secrets/admin_password")
if(p.is_file()):
    admin_password = p.open().readline().rstrip()
    admin_user_and_password = "admin:" + admin_password + "@"
else:
    admin_user_and_password = ""

DB_URL = "http://" + admin_user_and_password + "couchdb:5984/_users/"

@application.route('/', methods = ['POST'])
def add_user():
    """
    This endpoint handles creating a new user in the backend CouchDB database.

    Returns
    _______
    tuple
        The content, status code, and headers returned from CouchDB upon
        new user creation.  The returned value is passed directly through.
    """
    email = request.json['email']
    password = request.json['password']
    name = email.lower()
    params = {'name': name,
    'password': password,
    'type': 'user',
    # The exp- role is for Financier internally to check that the account is not
    # expired.  This would be relevant if we were charging for use, but we're not
    # so just set to the distant future.  Also set the verified flag to avoid
    # having to verify email address.
    'roles': [name, 'verified', 'exp-4102444799', 'userdb-' + name.encode('utf-8').hex()]}
    r = put(url = DB_URL + 'org.couchdb.user:' + name, json = params)
    return (r.content, r.status_code, r.headers.items())
