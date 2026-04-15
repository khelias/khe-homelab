#!/bin/bash
set -e

psql -v ON_ERROR_STOP=1 --username "postgres" <<-EOSQL
    CREATE USER nextcloud WITH PASSWORD '${NEXTCLOUD_DB_PASSWORD}';
    CREATE DATABASE nextcloud OWNER nextcloud;
    GRANT ALL ON SCHEMA public TO nextcloud;
EOSQL
