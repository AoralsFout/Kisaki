/**
 * 角色文件的应用层端口。
 *
 * 应用层只关心角色文件的语义，不直接依赖 Tauri 命令名或参数形状。
 * 读操作仍由既有 character loader 负责；这里集中定义编辑器需要的写删边界。
 */
export interface CharacterFilePort {
  writePrompt(characterId: string, content: string): Promise<void>
  writeDefinition(characterId: string, content: string): Promise<void>
  saveImage(characterId: string, filename: string, dataBase64: string): Promise<void>
  deleteImage(characterId: string, filename: string): Promise<void>
}
