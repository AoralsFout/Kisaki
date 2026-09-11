/** 配置持久化端口：只描述「按键读写字符串」，具体介质由基础设施决定。 */
export interface SettingsStoragePort {
  read(key: string): string | null
  write(key: string, value: string): void
}

/** 测试与无存储环境使用的内存实现。 */
export function createMemorySettingsStorage(
  initial: Record<string, string> = {},
): SettingsStoragePort {
  const values = new Map(Object.entries(initial))
  return {
    read: key => values.get(key) ?? null,
    write: (key, value) => { values.set(key, value) },
  }
}
