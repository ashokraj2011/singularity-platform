# M100 P1 — Edge gateway. A thin nginx that fronts all six UIs on one origin
# with path-prefix routing (see nginx.conf). No app code, no build — just the
# reverse-proxy config.
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
