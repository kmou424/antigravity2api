# 使用官方 Node.js 20 Alpine 镜像作为基础镜像
# Alpine 镜像体积小，安全性高，适合生产环境
FROM node:20-alpine

# 设置工作目录
WORKDIR /app

# 创建非 root 用户以提高安全性
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# 复制 package.json 和 package-lock.json
# 先复制依赖文件以利用 Docker 层缓存
COPY package*.json ./

# 安装依赖（使用 npm ci 确保依赖版本一致性）
RUN npm ci --only=production && \
    npm cache clean --force

# 复制应用程序代码
COPY . .

# 创建 data 目录用于存储 accounts.json
RUN mkdir -p /app/data && \
    chown -R nodejs:nodejs /app

# 切换到非 root 用户
USER nodejs

# 暴露应用端口
EXPOSE 8045

# 健康检查
# 注意：由于 /v1/ 端点需要 API Key 认证，这里使用简单的端口检查
# 如需更精确的健康检查，可以添加一个无需认证的 /health 端点
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider --timeout=2 http://localhost:8045/v1/models 2>&1 | grep -q "401\|200" && exit 0 || exit 1

# 启动应用
CMD ["node", "src/server/index.js"]

