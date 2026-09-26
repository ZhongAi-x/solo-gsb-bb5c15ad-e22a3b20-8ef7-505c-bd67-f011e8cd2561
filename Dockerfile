# ---------- 构建阶段 ----------
FROM node:20-alpine AS build
WORKDIR /app

# 优先复制依赖清单，利用 Docker 层缓存
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

# 复制源码并构建（初始化/编译随镜像构建完成）
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
RUN npm run build

# ---------- 运行阶段：nginx 托管静态产物 ----------
FROM nginx:1.27-alpine AS runtime

# 单页应用路由回退配置
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:80/ >/dev/null 2>&1 || exit 1

CMD ["nginx", "-g", "daemon off;"]
