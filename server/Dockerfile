FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY src/ ./src/
RUN mkdir -p /app/data
EXPOSE 5000
CMD ["node", "src/app.js"]
