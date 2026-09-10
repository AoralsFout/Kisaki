import { beforeEach, describe, expect, it } from 'vitest'
import {
  getAutoExecFiles,
  getScreenCaptureEnabled,
  setAutoExecFiles,
  setScreenCaptureEnabled,
} from '../toolPolicy'
import {
  appendFileTool,
  deleteFileTool,
  deleteLinesTool,
  insertLinesTool,
  readFileTool,
  replaceLinesTool,
  writeFileTool,
} from '../tools/files'
import { runProcessTool, runShellTool } from '../tools/command'
import { captureScreenTool } from '../tools/screenshot'

describe('tool policy descriptors', () => {
  it('declares file approval and checkpoint beside every mutating handler', () => {
    const mutations = [
      writeFileTool, appendFileTool, deleteFileTool,
      replaceLinesTool, insertLinesTool, deleteLinesTool,
    ]
    for (const tool of mutations) {
      expect(tool.policy).toEqual({
        requiresWorkspace: true,
        approval: 'file-session',
        checkpointArgument: 'path',
      })
    }
    expect(readFileTool.policy).toEqual({ requiresWorkspace: true })
  })

  it('declares command and screen approvals without name-based classification', () => {
    expect(runProcessTool.policy).toEqual({ requiresWorkspace: true, approval: 'command' })
    expect(runShellTool.policy).toEqual({ requiresWorkspace: true, approval: 'command' })
    expect(captureScreenTool.policy).toEqual({ approval: 'screen-capture' })
  })
})

describe('tool policy settings', () => {
  beforeEach(() => localStorage.clear())

  it('keeps automatic file execution disabled by default and persists changes', () => {
    expect(getAutoExecFiles()).toBe(false)
    setAutoExecFiles(true)
    expect(getAutoExecFiles()).toBe(true)
    setAutoExecFiles(false)
    expect(getAutoExecFiles()).toBe(false)
  })

  it('keeps screen capture disabled by default and persists changes', () => {
    expect(getScreenCaptureEnabled()).toBe(false)
    setScreenCaptureEnabled(true)
    expect(getScreenCaptureEnabled()).toBe(true)
    setScreenCaptureEnabled(false)
    expect(getScreenCaptureEnabled()).toBe(false)
  })
})
