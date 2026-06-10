FROM node:22

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

RUN npm run build

EXPOSE 3000
EXPOSE 3099

# Use exec-form trap so SIGTERM reaches the processes (not buried under sh -c).
CMD ["sh", "-c", "npm start & npm run ws & wait"]
