/**
 * 工具模块统一导出
 */
export { createLogger, setLogLevel, getLogLevel, getBuffer, clearBuffer, enableFilePersistence, subscribe, subscribeCrossWindow, redactSensitiveText } from './logger'
export type { Logger, LogLevel, LogEntry, LoggerConfig } from './logger'
