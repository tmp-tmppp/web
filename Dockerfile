# Image of the web UI. Two stages: the build stage bundles the app with the pinned Node.js, the runtime stage is an
# unprivileged nginx that serves the files. Both base images are pinned by tag and digest (the Node.js major of "engines"
# in package.json); Dependabot proposes updates. Lint, type check and tests run in the pipeline before the image is built,
# so this build only bundles ("npm run bundle").

# --- build stage -------------------------------------------------------------------------------------------
FROM node:24.22.2-trixie-slim@sha256:0820eaa85e07d0490446dd01d14707e17e6108a36988cf374899cd057eb3812d AS build
WORKDIR /app

# Dependencies first, so this layer stays cached while only the source changes.
COPY package.json package-lock.json .npmrc ./
RUN npm ci --ignore-scripts

COPY index.html tsconfig.json vite.config.ts ./
COPY public ./public
COPY src ./src
RUN npm run bundle

# --- runtime stage -----------------------------------------------------------------------------------------
# The stable nginx branch (1.30), Alpine without extra modules. The image listens on 8080 as the Service "web" of the
# gateway expects, and runs as the user 101.
FROM nginxinc/nginx-unprivileged:1.30.6-alpine-slim@sha256:5d8bb9437d74a600ec5dbf90c035451c724dc33eac8d3a71078f6f8612c345f6 AS runtime

USER root
# nginx.conf of the base image includes /etc/nginx/conf.d/*.conf. At start its entrypoint renders every file of
# /etc/nginx/templates into that folder (envsubst), after 18-chance-csp.envsh has put the origin of the issuer, read
# from config.json, into CHANCE_ISSUER_ORIGIN for the Content-Security-Policy.
COPY nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY nginx/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY nginx/18-chance-csp.envsh /docker-entrypoint.d/18-chance-csp.envsh
RUN chmod 0755 /docker-entrypoint.d/18-chance-csp.envsh && rm -rf /usr/share/nginx/html/*

# The app. dist/config.json holds the local development defaults (public/config.json); Kubernetes mounts the ConfigMap
# over it, and compose.yaml mounts a config file.
COPY --from=build /app/dist /usr/share/nginx/html

# The Helm chart also enforces a non-root user and a read-only file system (writable: /tmp and /etc/nginx/conf.d).
USER 101
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
