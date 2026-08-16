# Lekki kontener pomocniczy: pg_dump + gzip + gpg + curl na crondzie.
# Obraz waży ~40 MB, nie ma w nim Node ani kodu bota.
FROM alpine:3.20

# postgresql16-client MUSI odpowiadać wersji serwera (postgres:16-alpine),
# inaczej pg_dump odmówi zrzutu z nowszej bazy.
RUN apk add --no-cache \
      postgresql16-client \
      gnupg \
      curl \
      tzdata \
    && rm -rf /var/cache/apk/*

ENV TZ=Europe/Warsaw

COPY backup.sh /usr/local/bin/backup.sh
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/backup.sh /usr/local/bin/entrypoint.sh

VOLUME ["/backups"]

# Healthcheck: baza osiągalna i katalog zapisywalny.
HEALTHCHECK --interval=5m --timeout=10s --start-period=30s \
  CMD pg_isready -h "$POSTGRES_HOST" -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
      && test -w /backups || exit 1

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
