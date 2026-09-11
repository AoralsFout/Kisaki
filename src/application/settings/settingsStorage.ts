/** 配置持久化端口：只描述「按键读写字符串」，具体介质由基础设施决定。 */
export interface SettingsStoragePort {
  read(key: string): string | null
  write(key: string, value: string): void
}
