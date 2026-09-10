/**
 * Transitional boundary used while conversation execution moves out of ChatStore.
 * It keeps the chat workflow independent from Pinia's SessionStore module.
 */
export interface ChatSessionPort {
  currentSessionId(): string
  workspaceGrantId(): string | null
  persistCurrent(): void
  beginCheckpoint(messageId: string): string
  backupFile(checkpointId: string, relativePath: string): Promise<void>
  markCheckpointFiles(checkpointId: string): void
  clearCheckpoints(): Promise<void>
}
