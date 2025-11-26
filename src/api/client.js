import tokenManager from '../auth/token_manager.js';
import config from '../config/config.js';
import { generateToolCallId } from '../utils/idGenerator.js';

/**
 * 将 Gemini finishReason 转换为 OpenAI finish_reason
 * OpenAI finish_reason 可能的值：
 * - stop: 正常停止
 * - length: 达到 max_tokens 限制
 * - tool_calls: 需要调用工具
 * - content_filter: 内容被过滤
 * - function_call: 已废弃，使用 tool_calls
 */
function convertFinishReason(geminiFinishReason) {
  const mapping = {
    'STOP': 'stop',
    'MAX_TOKENS': 'length',
    'SAFETY': 'content_filter',
    'RECITATION': 'content_filter',
    'OTHER': 'stop',
    'FINISH_REASON_UNSPECIFIED': 'stop'
  };
  return mapping[geminiFinishReason] || 'stop';
}

function estimateTokens(text) {
  if (!text) return 0;
  const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const otherChars = text.length - chineseChars;
  return Math.ceil(chineseChars / 1.5 + otherChars / 4);
}

function processResponseData(responseData, callback, state) {
  const candidate = responseData.candidates?.[0];
  const parts = candidate?.content?.parts;
  
  if (candidate?.finishReason && !state.finishReason) {
    state.finishReason = convertFinishReason(candidate.finishReason);
  }
  
  if (responseData.usageMetadata) {
    if (responseData.usageMetadata.promptTokenCount) {
      state.promptTokens = responseData.usageMetadata.promptTokenCount;
    }
    if (responseData.usageMetadata.candidatesTokenCount) {
      state.completionTokens = responseData.usageMetadata.candidatesTokenCount;
    }
  }
  
  if (parts) {
    for (const part of parts) {
      if (part.thought === true) {
        if (!state.thinkingStarted) {
          callback({ type: 'thinking', content: '<think>\n' });
          state.thinkingStarted = true;
        }
        callback({ type: 'thinking', content: part.text || '' });
      } else if (part.text !== undefined) {
        if (state.thinkingStarted) {
          callback({ type: 'thinking', content: '\n</think>\n' });
          state.thinkingStarted = false;
        }
        state.fullContent += part.text;
        callback({ type: 'text', content: part.text });
      } else if (part.functionCall) {
        state.toolCalls.push({
          id: part.functionCall.id || generateToolCallId(),
          type: 'function',
          function: {
            name: part.functionCall.name,
            arguments: JSON.stringify(part.functionCall.args)
          }
        });
      }
    }
  }
  
  if (candidate?.finishReason && state.toolCalls.length > 0) {
    if (state.thinkingStarted) {
      callback({ type: 'thinking', content: '\n</think>\n' });
      state.thinkingStarted = false;
    }
    callback({ type: 'tool_calls', tool_calls: state.toolCalls });
    state.toolCalls = [];
  }
}

async function processStreamingResponse(response, callback, state) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    
    const chunk = decoder.decode(value);
    const lines = chunk.split('\n').filter(line => line.startsWith('data: '));
    
    for (const line of lines) {
      const jsonStr = line.slice(6);
      if (!jsonStr || jsonStr.trim() === '') continue;
      try {
        const data = JSON.parse(jsonStr);
        if (data.response) {
          processResponseData(data.response, callback, state);
        }
      } catch (e) {
        // 忽略解析错误
      }
    }
  }
}

async function processNonStreamingResponse(response, callback, state) {
  const data = await response.json();
  const responseData = data.response || data;
  processResponseData(responseData, callback, state);
}

export async function generateAssistantResponse(requestBody, stream, callback) {
  const token = await tokenManager.getToken();
  
  if (!token) {
    throw new Error('没有可用的token，请运行 npm run login 获取token');
  }

  const url = stream ? config.api.url : config.api.nonStreamUrl;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Host': config.api.host,
      'User-Agent': config.api.userAgent,
      'Authorization': `Bearer ${token.access_token}`,
      'Content-Type': 'application/json',
      'Accept-Encoding': 'gzip'
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorText = await response.text();
    if (response.status === 403) {
      tokenManager.disableCurrentToken(token);
      throw new Error(`该账号没有使用权限，已自动禁用。错误详情: ${errorText}`);
    }
    throw new Error(`API请求失败 (${response.status}): ${errorText}`);
  }

  const state = {
    thinkingStarted: false,
    toolCalls: [],
    finishReason: null,
    promptTokens: 0,
    completionTokens: 0,
    fullContent: ''
  };

  try {
    const requestText = JSON.stringify(requestBody);
    state.promptTokens = estimateTokens(requestText);
  } catch (e) {
    // 忽略错误
  }

  if (stream) {
    await processStreamingResponse(response, callback, state);
  } else {
    await processNonStreamingResponse(response, callback, state);
  }

  if (!state.finishReason) {
    state.finishReason = state.toolCalls.length > 0 ? 'tool_calls' : 'stop';
  }

  if (state.completionTokens === 0 && state.fullContent) {
    state.completionTokens = estimateTokens(state.fullContent);
  }

  return {
    finish_reason: state.finishReason,
    usage: {
      prompt_tokens: state.promptTokens,
      completion_tokens: state.completionTokens,
      total_tokens: state.promptTokens + state.completionTokens
    }
  };
}

export async function getAvailableModels() {
  const token = await tokenManager.getToken();
  
  if (!token) {
    throw new Error('没有可用的token，请运行 npm run login 获取token');
  }
  
  const response = await fetch(config.api.modelsUrl, {
    method: 'POST',
    headers: {
      'Host': config.api.host,
      'User-Agent': config.api.userAgent,
      'Authorization': `Bearer ${token.access_token}`,
      'Content-Type': 'application/json',
      'Accept-Encoding': 'gzip'
    },
    body: JSON.stringify({})
  });

  const data = await response.json();
  
  return {
    object: 'list',
    data: Object.keys(data.models).map(id => ({
      id,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'google'
    }))
  };
}
