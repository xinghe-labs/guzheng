# 「孤证」— 通用容器镜像（Fly.io / HF Spaces / 任何能跑 Docker 的免费平台）
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm install --omit=dev
COPY server.mjs ./
COPY index.html ./
COPY lib ./lib
# easy-websearch 内置脚本随依赖安装
ENV PORT=3000 GUZHENG_CACHE=/tmp/guzheng-cache MAX_CONCURRENT=2
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
