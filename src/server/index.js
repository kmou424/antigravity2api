import express from 'express';
import { generateAssistantResponse, getAvailableModels } from '../api/client.js';
import { generateRequestBody } from '../utils/utils.js';
import logger from '../utils/logger.js';
import config from '../config/config.js';

const app = express();

app.use(express.json({ limit: config.security.maxRequestSize }));

app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: `请求体过大，最大支持 ${config.security.maxRequestSize}` });
  }
  next(err);
});

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    logger.request(req.method, req.path, res.statusCode, Date.now() - start);
  });
  next();
});

app.use((req, res, next) => {
  if (req.path.startsWith('/v1/')) {
    const apiKey = config.security?.apiKey;
    if (apiKey) {
      const authHeader = req.headers.authorization;
      const providedKey = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
      if (providedKey !== apiKey) {
        logger.warn(`API Key 验证失败: ${req.method} ${req.path}`);
        return res.status(401).json({ error: 'Invalid API Key' });
      }
    }
  }
  next();
});

app.get('/v1/models', async (req, res) => {
  try {
    const models = await getAvailableModels();
    res.json(models);
  } catch (error) {
    logger.error('获取模型列表失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/v1/chat/completions', async (req, res) => {
  const { messages, model, stream = true, tools, ...params} = req.body;
  try {
    
    if (!messages) {
      return res.status(400).json({ error: 'messages is required' });
    }
    
    const requestBody = await generateRequestBody(messages, model, params, tools);
    //console.log(JSON.stringify(requestBody,null,2));
    
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      
      const id = `chatcmpl-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const created = Math.floor(Date.now() / 1000);
      let hasToolCall = false;
      let finalFinishReason = 'stop';
      let usage = null;
      
      const metadata = await generateAssistantResponse(requestBody, stream, (data) => {
        if (data.type === 'tool_calls') {
          hasToolCall = true;
          res.write(`data: ${JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ 
              index: 0, 
              delta: { tool_calls: data.tool_calls }, 
              finish_reason: null,
              logprobs: null
            }]
          })}\n\n`);
        } else if (data.type === 'thinking') {
          // 思考过程可以作为系统消息的一部分，但 OpenAI 格式不直接支持
          // 这里可以选择忽略或作为内容的一部分
        } else {
          res.write(`data: ${JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ 
              index: 0, 
              delta: { content: data.content }, 
              finish_reason: null,
              logprobs: null
            }]
          })}\n\n`);
        }
      });
      
      // 使用返回的元数据
      if (metadata) {
        finalFinishReason = metadata.finish_reason || (hasToolCall ? 'tool_calls' : 'stop');
        usage = metadata.usage;
      } else {
        finalFinishReason = hasToolCall ? 'tool_calls' : 'stop';
      }
      
      // 发送最终 chunk（包含 finish_reason 和 usage）
      const finalChunk = {
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ 
          index: 0, 
          delta: {}, 
          finish_reason: finalFinishReason,
          logprobs: null
        }]
      };
      
      // 如果 usage 信息可用，添加到最终 chunk 中（OpenAI 格式支持）
      if (usage) {
        finalChunk.usage = usage;
      }
      
      res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
      
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      let fullContent = '';
      let toolCalls = [];
      let thinkingContent = '';
      
      const metadata = await generateAssistantResponse(requestBody, stream, (data) => {
        if (data.type === 'tool_calls') {
          toolCalls = data.tool_calls;
        } else if (data.type === 'thinking') {
          thinkingContent += data.content;
        } else {
          fullContent += data.content || '';
        }
      });
      
      const message = { role: 'assistant', content: fullContent };
      if (toolCalls.length > 0) {
        message.tool_calls = toolCalls;
      }
      
      // 确定 finish_reason
      let finishReason = 'stop';
      if (toolCalls.length > 0) {
        finishReason = 'tool_calls';
      } else if (metadata?.finish_reason) {
        finishReason = metadata.finish_reason;
      }
      
      // 构建响应对象
      const response = {
        id: `chatcmpl-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model || 'unknown',
        choices: [{
          index: 0,
          message,
          finish_reason: finishReason,
          logprobs: null
        }]
      };
      
      // 添加 usage 信息（如果可用）
      if (metadata?.usage) {
        response.usage = metadata.usage;
      }
      
      // 添加 system_fingerprint（可选字段，用于标识模型版本）
      response.system_fingerprint = null;
      
      res.json(response);
    }
  } catch (error) {
    logger.error('生成响应失败:', error.message);
    if (!res.headersSent) {
      if (stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        const id = `chatcmpl-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
        const created = Math.floor(Date.now() / 1000);
        res.write(`data: ${JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created,
          model: model || 'unknown',
          choices: [{ 
            index: 0, 
            delta: { content: `错误: ${error.message}` }, 
            finish_reason: null,
            logprobs: null
          }]
        })}\n\n`);
        res.write(`data: ${JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created,
          model: model || 'unknown',
          choices: [{ 
            index: 0, 
            delta: {}, 
            finish_reason: 'stop',
            logprobs: null
          }]
        })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        res.status(500).json({ error: error.message });
      }
    }
  }
});

const server = app.listen(config.server.port, config.server.host, () => {
  logger.info(`服务器已启动: ${config.server.host}:${config.server.port}`);
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    logger.error(`端口 ${config.server.port} 已被占用`);
    process.exit(1);
  } else if (error.code === 'EACCES') {
    logger.error(`端口 ${config.server.port} 无权限访问`);
    process.exit(1);
  } else {
    logger.error('服务器启动失败:', error.message);
    process.exit(1);
  }
});

const shutdown = () => {
  logger.info('正在关闭服务器...');
  server.close(() => {
    logger.info('服务器已关闭');
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
