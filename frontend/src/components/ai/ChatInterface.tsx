'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { aiApi } from '@/lib/ai';
import { SuggestedQueries } from './SuggestedQueries';
import { ChatMessage } from './ChatMessage';
import type { StreamEvent } from '@/types/ai';
import toast from 'react-hot-toast';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolsUsed?: Array<{ name: string; summary: string }>;
  sources?: Array<{ type: string; description: string; dateRange?: string }>;
  isStreaming?: boolean;
  error?: string;
}

interface ThinkingState {
  active: boolean;
  message: string;
  tools: Array<{ name: string; status: 'running' | 'done'; summary?: string }>;
}

export function ChatInterface() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [thinking, setThinking] = useState<ThinkingState>({
    active: false,
    message: '',
    tools: [],
  });
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    if (messages.length > 0) {
      scrollToBottom();
    }
  }, [messages, thinking, scrollToBottom]);

  const handleSubmit = useCallback(
    async (queryText?: string) => {
      const query = queryText || input.trim();
      if (!query || isLoading) return;

      setInput('');
      setIsLoading(true);

      // Add user message
      const userMsgId = `user-${Date.now()}`;
      const assistantMsgId = `assistant-${Date.now()}`;

      setMessages((prev) => [
        ...prev,
        { id: userMsgId, role: 'user', content: query },
      ]);

      setThinking({ active: true, message: 'Analyzing your question...', tools: [] });

      const toolsUsed: Array<{ name: string; summary: string }> = [];
      let sources: Array<{ type: string; description: string; dateRange?: string }> = [];
      let contentBuffer = '';
      let hasStartedContent = false;

      const controller = aiApi.queryStream(query, {
        onEvent: (event: StreamEvent) => {
          switch (event.type) {
            case 'thinking':
              setThinking((prev) => ({
                ...prev,
                message: event.message || 'Thinking...',
              }));
              break;

            case 'tool_start':
              setThinking((prev) => ({
                ...prev,
                message: `Looking up ${event.name?.replace(/_/g, ' ')}...`,
                tools: [
                  ...prev.tools,
                  { name: event.name || '', status: 'running' },
                ],
              }));
              break;

            case 'tool_result':
              toolsUsed.push({
                name: event.name || '',
                summary: event.summary || '',
              });
              setThinking((prev) => ({
                ...prev,
                tools: prev.tools.map((t) =>
                  t.name === event.name
                    ? { ...t, status: 'done', summary: event.summary }
                    : t,
                ),
              }));
              break;

            case 'content':
              if (!hasStartedContent) {
                hasStartedContent = true;
                setThinking({ active: false, message: '', tools: [] });
                setMessages((prev) => [
                  ...prev,
                  {
                    id: assistantMsgId,
                    role: 'assistant',
                    content: event.text || '',
                    toolsUsed: [...toolsUsed],
                    isStreaming: true,
                  },
                ]);
              }
              contentBuffer += event.text || '';
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMsgId
                    ? { ...m, content: contentBuffer, toolsUsed: [...toolsUsed] }
                    : m,
                ),
              );
              break;

            case 'sources':
              sources = (event.sources as typeof sources) || [];
              break;

            case 'done':
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMsgId
                    ? { ...m, isStreaming: false, sources }
                    : m,
                ),
              );
              setIsLoading(false);
              setThinking({ active: false, message: '', tools: [] });
              break;

            case 'error':
              setThinking({ active: false, message: '', tools: [] });
              if (hasStartedContent) {
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantMsgId
                      ? { ...m, isStreaming: false, error: event.message as string }
                      : m,
                  ),
                );
              } else {
                setMessages((prev) => [
                  ...prev,
                  {
                    id: assistantMsgId,
                    role: 'assistant',
                    content: '',
                    error: (event.message as string) || 'An error occurred',
                  },
                ]);
              }
              setIsLoading(false);
              break;
          }
        },
        onDone: () => {
          setIsLoading(false);
          setThinking({ active: false, message: '', tools: [] });
        },
        onError: (error) => {
          setThinking({ active: false, message: '', tools: [] });
          setIsLoading(false);
          toast.error(error.message || 'Failed to get response');
          if (!hasStartedContent) {
            setMessages((prev) => [
              ...prev,
              {
                id: assistantMsgId,
                role: 'assistant',
                content: '',
                error: error.message || 'Failed to connect to the AI service.',
              },
            ]);
          }
        },
      });

      abortControllerRef.current = controller;
    },
    [input, isLoading],
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleCancel = () => {
    abortControllerRef.current?.abort();
    setIsLoading(false);
    setThinking({ active: false, message: '', tools: [] });
  };

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;
    }
  }, [input]);

  return (
    <div className="flex flex-col h-[calc(100vh-12rem)]">
      {/* Messages area */}
      <div className="flex-1 overflow-y-auto px-2 py-4">
        {messages.length === 0 && !thinking.active ? (
          <SuggestedQueries onSelect={handleSubmit} />
        ) : (
          <>
            {messages.map((msg) => (
              <ChatMessage
                key={msg.id}
                role={msg.role}
                content={msg.content}
                toolsUsed={msg.toolsUsed}
                sources={msg.sources}
                isStreaming={msg.isStreaming}
                error={msg.error}
              />
            ))}

            {/* Thinking indicator */}
            {thinking.active && (
              <div className="flex justify-start mb-4">
                <div className="max-w-[85%]">
                  <div className="px-4 py-3 rounded-2xl rounded-bl-sm bg-gray-100 dark:bg-gray-700/60">
                    <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
                      <svg
                        className="w-4 h-4 animate-spin"
                        fill="none"
                        viewBox="0 0 24 24"
                      >
                        <circle
                          className="opacity-25"
                          cx="12"
                          cy="12"
                          r="10"
                          stroke="currentColor"
                          strokeWidth="4"
                        />
                        <path
                          className="opacity-75"
                          fill="currentColor"
                          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                        />
                      </svg>
                      {thinking.message}
                    </div>
                    {thinking.tools.length > 0 && (
                      <div className="mt-2 space-y-1">
                        {thinking.tools.map((tool, i) => (
                          <div
                            key={i}
                            className="flex items-center gap-1.5 text-xs text-gray-400 dark:text-gray-500"
                          >
                            {tool.status === 'running' ? (
                              <svg
                                className="w-3 h-3 animate-spin"
                                fill="none"
                                viewBox="0 0 24 24"
                              >
                                <circle
                                  className="opacity-25"
                                  cx="12"
                                  cy="12"
                                  r="10"
                                  stroke="currentColor"
                                  strokeWidth="4"
                                />
                                <path
                                  className="opacity-75"
                                  fill="currentColor"
                                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                                />
                              </svg>
                            ) : (
                              <svg
                                className="w-3 h-3 text-green-500"
                                fill="none"
                                viewBox="0 0 24 24"
                                strokeWidth={2}
                                stroke="currentColor"
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  d="M4.5 12.75l6 6 9-13.5"
                                />
                              </svg>
                            )}
                            {tool.name.replace(/_/g, ' ')}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div className="border-t border-gray-200 dark:border-gray-700 pt-4 pb-2">
        <div className="flex gap-2 items-end">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about your finances..."
            disabled={isLoading}
            rows={1}
            className="flex-1 resize-none rounded-xl border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-4 py-2.5 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-50"
          />
          {isLoading ? (
            <button
              onClick={handleCancel}
              className="flex-shrink-0 p-2.5 rounded-xl bg-red-500 hover:bg-red-600 text-white transition-colors"
              title="Cancel"
            >
              <svg
                className="w-5 h-5"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={2}
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          ) : (
            <button
              onClick={() => handleSubmit()}
              disabled={!input.trim()}
              className="flex-shrink-0 p-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 dark:disabled:bg-gray-600 text-white transition-colors disabled:cursor-not-allowed"
              title="Send"
            >
              <svg
                className="w-5 h-5"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={2}
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5"
                />
              </svg>
            </button>
          )}
        </div>
        <p className="text-xs text-gray-400 dark:text-gray-500 mt-2 text-center">
          Press Enter to send, Shift+Enter for new line
        </p>
      </div>
    </div>
  );
}
