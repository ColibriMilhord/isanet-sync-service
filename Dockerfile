# Image officielle Microsoft Playwright : Chromium + toutes les libs système déjà installées
FROM mcr.microsoft.com/playwright:v1.47.0-jammy

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.mjs ./

# Le navigateur Chromium est déjà présent dans l'image, pas besoin de
# "npx playwright install" ici (contrairement au runtime Node natif).

EXPOSE 3000
CMD ["node", "server.mjs"]
