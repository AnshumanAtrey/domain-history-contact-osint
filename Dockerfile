# Playwright-capable base: the actor always renders pages headless, archived ones included.
FROM apify/actor-node-playwright-chrome:22

COPY --chown=myuser:myuser package*.json ./
RUN npm --quiet set progress=false \
 && npm install --omit=dev --omit=optional \
 && echo "installed:" && (npm ls --omit=dev --all || true)

COPY --chown=myuser:myuser . ./

CMD ["npm", "start", "--silent"]
