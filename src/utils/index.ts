/**
 * 工具模块统一导出
 */
export {
  createLogger,
  setLogLevel,
  getLogLevel,
  getBuffer,
  clearBuffer,
  enableFilePersistence,
  flushLogs,
  getPersistenceStatus,
  installGlobalErrorHandlers,
  normalizeError,
  subscribe,
  subscribeCrossWindow,
  redactSensitiveText,
} from './logger'
export type {
  Logger,
  LogLevel,
  LogEntry,
  LogRecord,
  LogContext,
  SerializedError,
  LoggerConfig,
} from './logger'
