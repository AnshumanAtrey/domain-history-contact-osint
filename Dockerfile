# Playwright-capable base: the actor always renders pages headless, archived ones included.
FROM apify/actor-node-playwright-chrome:22

COPY --chown=myuser:myuser package*.json ./
RUN npm --quiet set progress=false \
 && npm install --omit=dev --omit=optional \
 && echo "installed:" && (npm ls --omit=dev --all || true)

# Bake the multilingual NER model (173MB, int8) into the image. At runtime
# entities.js refuses remote fetches, so a cold container never stalls on a
# download and the model is exactly the one that was tested. This layer only
# rebuilds when package*.json changes, not on every code push.
RUN node --input-type=module -e " \
  const { pipeline, env } = await import('@huggingface/transformers'); \
  env.cacheDir = './models'; \
  await pipeline('token-classification', 'Xenova/bert-base-multilingual-cased-ner-hrl', { dtype: 'q8' }); \
  console.log('NER model cached in ./models'); \
"

COPY --chown=myuser:myuser . ./

CMD ["npm", "start", "--silent"]
