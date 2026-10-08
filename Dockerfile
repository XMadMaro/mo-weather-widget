FROM php:8.2-cli
WORKDIR /app
COPY . .
EXPOSE 8080
CMD sh -c "PHP_CLI_SERVER_WORKERS=4 php -S 0.0.0.0:$PORT -t public router.php"
