FROM php:8.2-cli
WORKDIR /app
COPY . .
EXPOSE 8080
# Radar burzowy: przy MO_RADAR_MODE=producer w tle działa pętla producenta klatek (docs/RADAR-PLAN.md C.6).
# `while true` podnosi go po każdym błędzie; główny proces to nadal serwer PHP (restartPolicy Railway).
CMD sh -c "if [ \"$MO_RADAR_MODE\" = producer ]; then (while true; do php scripts/radar-worker.php; sleep 60; done) & fi; PHP_CLI_SERVER_WORKERS=4 php -S 0.0.0.0:$PORT -t public router.php"
