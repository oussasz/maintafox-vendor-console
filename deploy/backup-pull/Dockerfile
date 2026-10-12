# Read-only SFTP access to the ENCRYPTED backups, for the on-premise copy (README.md here).
# One account, mfxpull: SSH key only, SFTP only, read-only, chrooted to /pull, which holds only the
# backup volumes mounted read-only. uid/gid 70 = the owner of the backup files (BACKUP_FILES_OWNER
# in docker-compose.yml, the postgres user of the postgres image), so it can read them while they
# stay mode 600.
FROM alpine:3.20
# adduser -D leaves the password locked ("!"), which OpenSSH treats as a locked account even for
# key logins; "*" means "no password can ever match" and keeps key login possible.
RUN apk add --no-cache openssh-server \
  && addgroup -g 70 mfxpull \
  && adduser -D -H -h / -s /sbin/nologin -u 70 -G mfxpull mfxpull \
  && sed -i 's/^mfxpull:!:/mfxpull:*:/' /etc/shadow \
  && mkdir -p /pull/backups /pull/wal /etc/ssh/hostkeys /etc/ssh/authorized_keys \
  && chmod 755 /pull
COPY sshd_config /etc/ssh/sshd_config
COPY entrypoint.sh /entrypoint.sh
EXPOSE 2222
ENTRYPOINT ["sh", "/entrypoint.sh"]
