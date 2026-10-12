# The postgres service image: the official postgres:16-alpine plus the age program, which
# archive_command (deploy/backup/wal-archive.sh) uses to encrypt every WAL segment it archives
# when BACKUP_LOCAL_ENCRYPTION=required. Same server binaries and data format as postgres:16-alpine;
# built from the locally cached base image (no --pull), so the server version does not change.
FROM postgres:16-alpine
RUN apk add --no-cache age
